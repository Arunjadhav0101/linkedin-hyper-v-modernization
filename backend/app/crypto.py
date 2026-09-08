import base64
import hashlib
import os
from typing import Optional
from cryptography.fernet import Fernet, InvalidToken

# Master encryption key from environment or persistent local file fallback
KEY_ENV = os.getenv("LINKEDIN_ENCRYPTION_KEY")
KEY_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".encryption_key"))


def _get_or_create_fernet() -> Fernet:
    if KEY_ENV:
        # Derive standard 32-byte urlsafe base64 key from environment string
        digest = hashlib.sha256(KEY_ENV.encode()).digest()
        key = base64.urlsafe_b64encode(digest)
        return Fernet(key)

    if os.path.exists(KEY_FILE):
        try:
            with open(KEY_FILE, "rb") as f:
                key = f.read().strip()
                if key:
                    return Fernet(key)
        except Exception:
            pass

    # Generate and persist fallback encryption key
    new_key = Fernet.generate_key()
    try:
        with open(KEY_FILE, "wb") as f:
            f.write(new_key)
    except Exception:
        pass
    return Fernet(new_key)


_fernet = _get_or_create_fernet()


def encrypt_token(raw_token: Optional[str]) -> Optional[str]:
    """Encrypts a plaintext access/refresh token using AES-128-CBC/HMAC-SHA256."""
    if not raw_token or not raw_token.strip():
        return None
    try:
        return _fernet.encrypt(raw_token.strip().encode()).decode()
    except Exception as e:
        raise ValueError(f"Failed to encrypt credential: {str(e)}")


def decrypt_token(cipher_text: Optional[str]) -> Optional[str]:
    """Decrypts an encrypted credential back to plaintext."""
    if not cipher_text or not cipher_text.strip():
        return None
    try:
        return _fernet.decrypt(cipher_text.strip().encode()).decode()
    except InvalidToken:
        return None
    except Exception as e:
        raise ValueError(f"Failed to decrypt credential: {str(e)}")


def redact_token(token: Optional[str]) -> str:
    """Safely redacts a sensitive token for display or logs (e.g. 'AQED...26iw')."""
    if not token:
        return "[NOT_CONFIGURED]"
    if len(token) <= 10:
        return "[REDACTED]"
    return f"{token[:4]}...{token[-4:]}"
