import re
import urllib.parse
from typing import Dict, Any, Optional, Tuple, List
import httpx
from .models import LinkedInAccount


class MissingIntegrationError(Exception):
    pass


class ValidationError(Exception):
    pass


class VoyagerApiError(Exception):
    def __init__(self, status_code: int, message: str, body: Any = None):
        super().__init__(f"LinkedIn Voyager API Error ({status_code}): {message}")
        self.status_code = status_code
        self.message = message
        self.body = body


class VoyagerClient:
    BASE_URL = "https://www.linkedin.com/voyager/api"

    @staticmethod
    def clean_profile_identifier(raw: str) -> str:
        """Strips URL prefixes, vanity slashes, and spaces."""
        clean = raw.strip()
        if "linkedin.com/in/" in clean:
            match = re.search(r"linkedin\.com/in/([a-zA-Z0-9\-_%]+)", clean)
            if match:
                clean = urllib.parse.unquote(match.group(1))
        clean = re.sub(r"\s+", "-", clean).rstrip("/")
        return clean

    @staticmethod
    def validate_session(account: LinkedInAccount) -> Tuple[str, str]:
        """Validates that an account possesses an authorized session cookie."""
        cookies = account.cookies or {}
        li_at = (cookies.get("li_at") or "").strip().strip('"\'')
        jsessionid = (cookies.get("JSESSIONID") or "").strip().strip('"\'')

        if not li_at:
            raise MissingIntegrationError(
                f"Account '{account.email}' is not authorized. Missing required 'li_at' session cookie."
            )

        if len(li_at) < 50:
            raise MissingIntegrationError(
                f"Invalid LinkedIn session cookie: The 'li_at' cookie for '{account.email}' is only {len(li_at)} characters. "
                f"A real LinkedIn session cookie is ~150 chars starting with 'AQED...'. You entered a password or placeholder."
            )

        return li_at, jsessionid

    def _get_headers(self, account: LinkedInAccount) -> Dict[str, str]:
        li_at, jsessionid = self.validate_session(account)
        csrf_token = jsessionid.replace('"', "")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/vnd.linkedin.normalized+json+2.1",
            "Content-Type": "application/json; charset=UTF-8",
            "x-li-lang": "en_US",
            "x-restli-protocol-version": "2.0.0",
            "Cookie": f'li_at={li_at}; JSESSIONID="{csrf_token}"',
        }
        if csrf_token:
            headers["csrf-token"] = csrf_token
        return headers

    def verify_session(self, account: LinkedInAccount) -> Dict[str, Any]:
        """Tests the session directly with LinkedIn via GET /voyager/api/me."""
        headers = self._get_headers(account)
        url = f"{self.BASE_URL}/me"

        with httpx.Client(timeout=15.0, follow_redirects=False) as client:
            resp = client.get(url, headers=headers)

            if resp.status_code == 200:
                data = resp.json()
                return {
                    "verified": True,
                    "publicIdentifier": data.get("publicIdentifier"),
                    "plainId": data.get("plainId"),
                    "message": "LinkedIn session verified successfully (200 OK)",
                }
            elif resp.status_code in (401, 302):
                raise VoyagerApiError(401, "Session expired or invalidated by LinkedIn (401 Unauthorized)")
            else:
                raise VoyagerApiError(resp.status_code, f"LinkedIn responded with HTTP {resp.status_code}")

    def resolve_profile_id(self, account: LinkedInAccount, identifier: str) -> str:
        """Resolves a public vanity name (e.g. 'satyanadella') to member URN via modern dash profiles."""
        clean = self.clean_profile_identifier(identifier)
        if clean.startswith("urn:li:") or clean.startswith("ACoAA"):
            return clean

        headers = self._get_headers(account)
        encoded = urllib.parse.quote(clean)
        url = f"{self.BASE_URL}/identity/dash/profiles?q=memberIdentity&memberIdentity={encoded}"

        try:
            with httpx.Client(timeout=15.0, follow_redirects=False) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    elements = data.get("*elements") or data.get("elements") or []
                    if elements:
                        return elements[0]
        except Exception:
            pass

        return clean

    def send_connection_request(
        self, account: LinkedInAccount, target_identifier: str, custom_note: Optional[str] = None
    ) -> Dict[str, str]:
        """Sends real connection request with optional message note to a LinkedIn profile."""
        clean_target = self.clean_profile_identifier(target_identifier)

        # Self-Action Guard: Do not permit sending invitation to own account
        if (
            (account.publicIdentifier and clean_target.lower() == account.publicIdentifier.lower())
            or (account.linkedinId and clean_target.lower() == account.linkedinId.lower())
            or (account.email and clean_target.lower() == account.email.lower())
        ):
            raise ValidationError(f"Cannot send connection request to your own profile ('{clean_target}')")

        resolved_id = self.resolve_profile_id(account, clean_target)

        # Check if resolved profile matches own profile
        if account.publicIdentifier and account.publicIdentifier in resolved_id:
            raise ValidationError(f"Cannot send connection request to your own profile ('{clean_target}')")

        # Strip URN prefix for normInvitations payload
        invite_id = resolved_id
        if invite_id.startswith("urn:li:fsd_profile:"):
            invite_id = invite_id.replace("urn:li:fsd_profile:", "")
        elif invite_id.startswith("urn:li:fs_miniProfile:"):
            invite_id = invite_id.replace("urn:li:fs_miniProfile:", "")

        payload = {
            "invitee": {
                "com.linkedin.voyager.growth.invitation.InviteeProfile": {
                    "profileId": invite_id,
                }
            },
            "message": custom_note if custom_note and custom_note.strip() else None,
        }

        headers = self._get_headers(account)
        url = f"{self.BASE_URL}/growth/normInvitations"

        with httpx.Client(timeout=20.0, follow_redirects=False) as client:
            resp = client.post(url, headers=headers, json=payload)
            if resp.status_code not in (200, 201):
                try:
                    err_json = resp.json()
                    msg = err_json.get("message") or f"HTTP {resp.status_code}"
                except Exception:
                    msg = f"HTTP {resp.status_code}"
                raise VoyagerApiError(resp.status_code, msg)

            try:
                res_data = resp.json()
                invitation_id = (
                    res_data.get("value", {}).get("invitationId")
                    or res_data.get("invitationId")
                    or f"inv_{int(httpx._utils.get_timestamp() * 1000)}"
                )
            except Exception:
                invitation_id = f"inv_{int(httpx._utils.get_timestamp() * 1000)}"

            return {"invitationId": invitation_id, "resolvedProfileId": resolved_id}

    def send_message(
        self,
        account: LinkedInAccount,
        recipient_id: str,
        content: str,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, str]:
        """Sends real LinkedIn message to an authorized recipient."""
        clean_recipient = self.clean_profile_identifier(recipient_id)

        # Self-Action Guard: Do not send message to own account
        if (
            (account.publicIdentifier and clean_recipient.lower() == account.publicIdentifier.lower())
            or (account.linkedinId and clean_recipient.lower() == account.linkedinId.lower())
            or (account.email and clean_recipient.lower() == account.email.lower())
        ):
            raise ValidationError(f"Cannot send message to your own profile ('{clean_recipient}')")

        if conversation_id:
            payload = {
                "eventCreate": {
                    "value": {
                        "com.linkedin.voyager.messaging.create.MessageCreate": {
                            "body": content,
                            "attributedBody": {"text": content, "attributes": []},
                        }
                    }
                },
                "dedupeByClientGeneratedToken": False,
            }
            url = f"{self.BASE_URL}/messaging/conversations/{conversation_id}/events"
        else:
            payload = {
                "keyVersion": "LEGACY_INBOX",
                "conversationCreate": {
                    "recipients": [clean_recipient],
                    "subtype": "MEMBER_TO_MEMBER",
                    "eventCreate": {
                        "value": {
                            "com.linkedin.voyager.messaging.create.MessageCreate": {
                                "body": content,
                                "attributedBody": {"text": content, "attributes": []},
                            }
                        }
                    },
                },
            }
            url = f"{self.BASE_URL}/messaging/conversations?action=create"

        headers = self._get_headers(account)

        with httpx.Client(timeout=20.0, follow_redirects=False) as client:
            resp = client.post(url, headers=headers, json=payload)
            if resp.status_code not in (200, 201):
                try:
                    err_json = resp.json()
                    msg = err_json.get("message") or f"HTTP {resp.status_code}"
                except Exception:
                    msg = f"HTTP {resp.status_code}"
                raise VoyagerApiError(resp.status_code, msg)

            try:
                res_data = resp.json()
                remote_msg_id = (
                    res_data.get("value", {}).get("backendEventId")
                    or res_data.get("backendEventId")
                    or f"msg_{int(httpx._utils.get_timestamp() * 1000)}"
                )
                conv_urn = (
                    conversation_id
                    or res_data.get("value", {}).get("conversationUrn", "").replace("urn:li:fs_conversation:", "")
                    or f"conv_{clean_recipient}"
                )
            except Exception:
                remote_msg_id = f"msg_{int(httpx._utils.get_timestamp() * 1000)}"
                conv_urn = conversation_id or f"conv_{clean_recipient}"

            return {"remoteMessageId": remote_msg_id, "conversationId": conv_urn}

    def fetch_conversations(self, account: LinkedInAccount, limit: int = 20) -> List[Dict[str, Any]]:
        """Fetches conversations and recent message events for synchronization."""
        headers = self._get_headers(account)
        url = f"{self.BASE_URL}/messaging/conversations?keyVersion=LEGACY_INBOX"

        with httpx.Client(timeout=20.0, follow_redirects=False) as client:
            resp = client.get(url, headers=headers)
            if resp.status_code != 200:
                raise VoyagerApiError(resp.status_code, f"Failed to fetch conversations (HTTP {resp.status_code})")

            try:
                data = resp.json()
                elements = data.get("elements") or []
                conversations = []
                for el in elements[:limit]:
                    conv_urn = el.get("entityUrn", "").replace("urn:li:fs_conversation:", "")
                    events = el.get("events") or []
                    conversations.append({"conversationId": conv_urn, "messages": events})
                return conversations
            except Exception as e:
                raise VoyagerApiError(500, f"Error parsing conversation stream: {str(e)}")
