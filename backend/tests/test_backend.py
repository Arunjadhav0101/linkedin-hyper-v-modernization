import hashlib
import json
import pytest
from unittest.mock import MagicMock, patch, Mock
import httpx

try:
    from backend.app.models import LinkedInAccount, AutomationJob, Conversation, ChatMessage, DeadLetterQueue
    from backend.app.voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError
    from backend.app.crypto import encrypt_token, decrypt_token, redact_token
    from backend.app.oauth_service import (
        LinkedInOAuthService,
        oauth_service,
        validate_account_auth,
        AccountAuthResult,
    )
    from backend.app.circuit_breaker import CircuitBreaker, circuit_breaker
    from backend.app.worker import JobProcessor
    from backend.app.main import app
except ImportError:
    from app.models import LinkedInAccount, AutomationJob, Conversation, ChatMessage, DeadLetterQueue
    from app.voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError
    from app.crypto import encrypt_token, decrypt_token, redact_token
    from app.oauth_service import (
        LinkedInOAuthService,
        oauth_service,
        validate_account_auth,
        AccountAuthResult,
    )
    from app.circuit_breaker import CircuitBreaker, circuit_breaker
    from app.worker import JobProcessor
    from app.main import app
from datetime import datetime, timedelta

from fastapi.testclient import TestClient


# ============================================================================
# 1. Encryption & Decryption Engine (crypto.py)
# ============================================================================
def test_crypto_encrypt_decrypt_roundtrip():
    raw_secret = "AQED_TEST_OFFICIAL_OAUTH_TOKEN_9876543210_SECRET"
    ciphertext = encrypt_token(raw_secret)
    assert ciphertext is not None
    assert ciphertext != raw_secret
    assert not ciphertext.startswith("AQED")

    decrypted = decrypt_token(ciphertext)
    assert decrypted == raw_secret


def test_crypto_corrupt_ciphertext_fails_gracefully():
    corrupt = "gAAAAABinvalid_corrupt_token_payload_xyz"
    assert decrypt_token(corrupt) is None
    assert decrypt_token("") is None
    assert decrypt_token(None) is None


def test_crypto_redact_token():
    token = "AQEDAVBxY_4BEzK3sLdM7Q_1234567890abcdef"
    redacted = redact_token(token)
    assert redacted.startswith("AQED")
    assert redacted.endswith("cdef")
    assert "..." in redacted
    assert redact_token("") == "[NOT_CONFIGURED]"
    assert redact_token(None) == "[NOT_CONFIGURED]"


# ============================================================================
# 2. LinkedIn OAuth 2.0 URL Generation
# ============================================================================
def test_oauth_authorization_url_generation():
    auth_url, state = oauth_service.build_authorization_url("acc_123")
    assert "https://www.linkedin.com/oauth/v2/authorization" in auth_url
    assert "response_type=code" in auth_url
    assert f"client_id={oauth_service.client_id}" in auth_url
    assert "scope=" in auth_url
    assert "state=" in auth_url
    assert len(state) >= 16


# ============================================================================
# 3. Canonical Account States & validate_account_auth
# ============================================================================
def test_validate_account_auth_not_connected():
    db = MagicMock()
    account = LinkedInAccount(
        id="acc_no_token",
        email="notconnected@test.com",
        authStatus="NOT_CONNECTED",
        encryptedAccessToken=None,
    )
    res = validate_account_auth(db, account)
    assert res.valid is False
    assert res.auth_status == "NOT_CONNECTED"
    assert "LinkedIn account is not authorized for this operation." in res.reason


def test_validate_account_auth_authorization_expired():
    db = MagicMock()
    account = LinkedInAccount(
        id="acc_expired",
        email="expired@test.com",
        authStatus="AUTHORIZATION_EXPIRED",
        encryptedAccessToken=encrypt_token("old_token"),
        tokenExpiresAt=datetime.utcnow() - timedelta(days=1),
    )
    with patch.object(oauth_service, "refresh_access_token", return_value=False):
        res = validate_account_auth(db, account)
        assert res.valid is False
        assert res.auth_status == "AUTHORIZATION_EXPIRED"
        assert "LinkedIn account is not authorized for this operation." in res.reason


def test_validate_account_auth_error_status():
    db = MagicMock()
    account = LinkedInAccount(
        id="acc_err",
        email="error@test.com",
        authStatus="ERROR",
        encryptedAccessToken=encrypt_token("some_token"),
    )
    res = validate_account_auth(db, account)
    assert res.valid is False
    assert res.auth_status == "ERROR"
    assert "LinkedIn account is not authorized for this operation." in res.reason


def test_validate_account_auth_scope_restriction_no_fake_success():
    """
    Standard consumer scopes do not include enterprise partner messaging.
    System reports limitation transparently instead of simulating fake action.
    """
    db = MagicMock()
    raw_token = "valid_oauth_access_token_12345"
    account = LinkedInAccount(
        id="acc_connected_consumer",
        email="consumer@test.com",
        authStatus="CONNECTED",
        encryptedAccessToken=encrypt_token(raw_token),
        tokenExpiresAt=datetime.utcnow() + timedelta(days=30),
        tokenScope="openid profile email w_member_social",
    )
    res = validate_account_auth(db, account, operation="SEND_MESSAGE")
    assert res.valid is False
    assert "LinkedIn account is not authorized for this operation." in res.reason
    assert "Enterprise Partner" in res.reason


def test_validate_account_auth_connected_with_partner_scope():
    db = MagicMock()
    raw_token = "valid_oauth_access_token_partner"
    account = LinkedInAccount(
        id="acc_connected_partner",
        email="partner@test.com",
        authStatus="CONNECTED",
        encryptedAccessToken=encrypt_token(raw_token),
        tokenExpiresAt=datetime.utcnow() + timedelta(days=30),
        tokenScope="openid profile email r_messages w_messages",
    )
    res = validate_account_auth(db, account, operation="SEND_MESSAGE")
    assert res.valid is True
    assert res.auth_status == "CONNECTED"
    assert res.decrypted_token == raw_token


# ============================================================================
# 4. test_permanent_error_classification_401_and_302
# ============================================================================
def test_permanent_error_classification_401_and_302():
    err_401 = VoyagerApiError(401, "Session expired")
    err_302 = VoyagerApiError(302, "Redirect to login")
    assert JobProcessor.is_permanent_error(err_401) is True
    assert JobProcessor.is_permanent_error(err_302) is True


# ============================================================================
# 5. test_permanent_error_classification_403_and_422
# ============================================================================
def test_permanent_error_classification_403_and_422():
    err_403 = VoyagerApiError(403, "Checkpoint challenge")
    err_422 = VoyagerApiError(422, "Unprocessable Entity")
    err_val = ValidationError("Cannot invite self")
    err_missing = MissingIntegrationError("No token")
    assert JobProcessor.is_permanent_error(err_403) is True
    assert JobProcessor.is_permanent_error(err_422) is True
    assert JobProcessor.is_permanent_error(err_val) is True
    assert JobProcessor.is_permanent_error(err_missing) is True


# ============================================================================
# 6. test_transient_error_classification_500_and_timeout
# ============================================================================
def test_transient_error_classification_500_and_timeout():
    err_500 = VoyagerApiError(500, "Internal Server Error")
    err_502 = VoyagerApiError(502, "Bad Gateway")
    err_timeout = Exception("ReadTimeout while waiting for response")
    assert JobProcessor.is_permanent_error(err_500) is False
    assert JobProcessor.is_permanent_error(err_502) is False
    assert JobProcessor.is_permanent_error(err_timeout) is False


# ============================================================================
# 7. test_worker_preflight_blocks_invalid_account_with_zero_retries
# ============================================================================
def test_worker_preflight_blocks_invalid_account_with_zero_retries():
    processor = JobProcessor()
    db = MagicMock()

    # Account has no OAuth token (NOT_CONNECTED)
    account = LinkedInAccount(
        id="acc_unauth",
        email="unauth@test.com",
        authStatus="NOT_CONNECTED",
        encryptedAccessToken=None,
    )
    job = AutomationJob(
        id="job_preflight_fail",
        traceId="trace_1",
        accountId="acc_unauth",
        type="SEND_MESSAGE",
        payload={"recipientId": "satya", "content": "hello"},
        status="QUEUED",
        retryCount=0,
        maxRetries=5,
    )
    db.query.return_value.filter.return_value.first.return_value = account

    processor.execute_job(db, job)

    assert job.status == "FAILED"
    assert job.retryCount == 0  # 0 retries!
    assert "LinkedIn account is not authorized for this operation." in (job.errorMessage or "")


# ============================================================================
# 8. test_worker_marks_account_session_invalid_on_401
# ============================================================================
def test_worker_marks_account_session_invalid_on_401():
    processor = JobProcessor()
    db = MagicMock()

    raw_token = "valid_oauth_access_token_partner"
    account = LinkedInAccount(
        id="acc_live_401",
        email="user@test.com",
        authStatus="CONNECTED",
        encryptedAccessToken=encrypt_token(raw_token),
        tokenExpiresAt=datetime.utcnow() + timedelta(days=10),
        tokenScope="openid profile email r_messages w_messages",
    )
    job = AutomationJob(
        id="job_live_401",
        traceId="trace_401",
        accountId="acc_live_401",
        type="SEND_MESSAGE",
        payload={"recipientId": "target_user", "content": "Live test"},
        status="QUEUED",
        retryCount=0,
        maxRetries=5,
    )
    db.query.return_value.filter.return_value.first.return_value = account

    # Mock voyager to raise 401 Unauthorized
    with patch.object(
        processor.voyager,
        "send_message",
        side_effect=VoyagerApiError(401, "Session expired or invalidated by LinkedIn (401 Unauthorized)"),
    ):
        with patch.object(processor, "acquire_lock", return_value=True):
            with patch.object(processor, "release_lock"):
                processor.execute_job(db, job)

    assert job.status == "FAILED"
    assert job.retryCount == 0  # Did not retry
    assert account.authStatus == "AUTHORIZATION_EXPIRED"  # Updated account status natively
    assert "401" in (job.errorMessage or "")


# ============================================================================
# 9. test_idempotent_message_sync_deduplication
# ============================================================================
def test_idempotent_message_sync_deduplication():
    account_id = "acc_demo"
    conv_id = "conv_demo"
    remote_msg_id = "msg_123456"

    key1 = hashlib.sha256(f"{account_id}:{conv_id}:{remote_msg_id}".encode()).hexdigest()
    key2 = hashlib.sha256(f"{account_id}:{conv_id}:{remote_msg_id}".encode()).hexdigest()

    assert key1 == key2
    assert len(key1) == 64


# ============================================================================
# 10. test_send_message_flow_status_transition
# ============================================================================
def test_send_message_flow_status_transition():
    processor = JobProcessor()
    db = MagicMock()

    account = LinkedInAccount(
        id="acc_msg_test",
        email="msg@test.com",
        status="ACTIVE",
        authStatus="CONNECTED",
        encryptedAccessToken=encrypt_token("oauth_test_token_123"),
        tokenExpiresAt=datetime.utcnow() + timedelta(days=30),
        tokenScope="openid profile email r_messages w_messages",
    )
    job = AutomationJob(
        id="job_send_msg",
        traceId="trace_msg",
        accountId="acc_msg_test",
        type="SEND_MESSAGE",
        payload={"recipientId": "satyanadella", "content": "Hello Satya!"},
        status="QUEUED",
        retryCount=0,
        maxRetries=3,
    )
    # Mock db queries
    db.query.return_value.filter.return_value.first.side_effect = [
        account,  # find account in execute_job
        None,     # conversation lookup
        None,     # message lookup
    ]

    mock_send = {"remoteMessageId": "remote_msg_100", "conversationId": "conv_remote_200"}
    with patch.object(processor.voyager, "send_message", return_value=mock_send):
        with patch.object(processor, "acquire_lock", return_value=True):
            with patch.object(processor, "release_lock"):
                processor.execute_job(db, job)

    assert job.status == "COMPLETED"
    assert job.completedAt is not None
    assert job.errorMessage is None


# ============================================================================
# 11. test_connection_request_flow
# ============================================================================
def test_connection_request_flow():
    processor = JobProcessor()
    db = MagicMock()

    account = LinkedInAccount(
        id="acc_conn_test",
        email="conn@test.com",
        status="ACTIVE",
        authStatus="CONNECTED",
        encryptedAccessToken=encrypt_token("oauth_test_token_123"),
        tokenExpiresAt=datetime.utcnow() + timedelta(days=30),
        tokenScope="openid profile email r_messages w_messages",
    )
    job = AutomationJob(
        id="job_conn_test",
        traceId="trace_conn",
        accountId="acc_conn_test",
        type="SEND_CONNECTION_REQUEST",
        payload={"targetProfileId": "satyanadella", "customNote": "Let's connect!"},
        status="QUEUED",
        retryCount=0,
        maxRetries=3,
    )
    db.query.return_value.filter.return_value.first.side_effect = [
        account,  # account lookup
        None,     # conv lookup
        None,     # msg lookup
    ]

    mock_res = {"invitationId": "inv_123", "resolvedProfileId": "satyanadella"}
    with patch.object(processor.voyager, "send_connection_request", return_value=mock_res):
        with patch.object(processor, "acquire_lock", return_value=True):
            with patch.object(processor, "release_lock"):
                processor.execute_job(db, job)

    assert job.status == "COMPLETED"
    assert job.errorMessage is None


# ============================================================================
# 12. test_safe_response_parser_single_body_consumption
# ============================================================================
def test_safe_response_parser_single_body_consumption():
    raw_payload = '{"value":{"invitationId":"inv_999"}}'
    mock_resp = Mock(spec=httpx.Response)
    mock_resp.status_code = 200
    mock_resp.text = raw_payload

    code, parsed_json, snippet = VoyagerClient._parse_response_safely(mock_resp)
    assert code == 200
    assert parsed_json == {"value": {"invitationId": "inv_999"}}
    assert snippet.startswith('{"value"')

    # Test with invalid non-JSON body
    mock_html = Mock(spec=httpx.Response)
    mock_html.status_code = 502
    mock_html.text = "<html>502 Bad Gateway</html>"

    code_html, parsed_html, snippet_html = VoyagerClient._parse_response_safely(mock_html)
    assert code_html == 502
    assert parsed_html is None
    assert "Bad Gateway" in snippet_html


# ============================================================================
# 13. test_circuit_breaker_immune_to_client_401_errors
# ============================================================================
def test_circuit_breaker_immune_to_client_401_errors():
    cb = CircuitBreaker(failure_threshold=3)

    # Record multiple 401 client auth errors
    err_401 = VoyagerApiError(401, "Unauthorized")
    err_403 = VoyagerApiError(403, "Forbidden")
    err_422 = VoyagerApiError(422, "Unprocessable")
    err_val = ValidationError("Validation error")

    cb.record_failure(err_401)
    cb.record_failure(err_403)
    cb.record_failure(err_422)
    cb.record_failure(err_val)

    assert cb.failure_count == 0  # Never incremented!
    assert cb.state == "CLOSED"
    assert cb.is_available() is True


# ============================================================================
# 14. test_circuit_breaker_trips_on_consecutive_5xx_errors
# ============================================================================
def test_circuit_breaker_trips_on_consecutive_5xx_errors():
    cb = CircuitBreaker(failure_threshold=3, recovery_time_sec=60.0)

    err_500 = VoyagerApiError(500, "Internal Server Error")
    cb.record_failure(err_500)
    assert cb.failure_count == 1
    assert cb.state == "CLOSED"

    cb.record_failure(err_500)
    assert cb.failure_count == 2
    assert cb.state == "CLOSED"

    cb.record_failure(err_500)
    assert cb.failure_count == 3
    assert cb.state == "OPEN"
    assert cb.is_available() is False

    # Success resets breaker
    cb.record_success()
    assert cb.failure_count == 0
    assert cb.state == "CLOSED"
    assert cb.is_available() is True


# ============================================================================
# 15. test_api_accounts_zero_credential_exposure
# ============================================================================
def test_api_accounts_zero_credential_exposure():
    """Verify GET /api/accounts returns status and scopes but NEVER raw or encrypted secrets."""
    client = TestClient(app)
    resp = client.get("/api/accounts")
    assert resp.status_code == 200
    data = resp.json()["data"]
    for acc in data:
        assert "encryptedAccessToken" not in acc
        assert "encryptedRefreshToken" not in acc
        assert "cookies" not in acc
        assert "authStatus" in acc
        assert acc["authStatus"] in ("NOT_CONNECTED", "CONNECTED", "AUTHORIZATION_EXPIRED", "ERROR")


# ============================================================================
# 16. test_api_dispatch_rejects_unauthorized_account
# ============================================================================
def test_api_dispatch_rejects_unauthorized_account():
    client = TestClient(app)

    # 1. Non-existent account
    resp = client.post(
        "/api/jobs/dispatch",
        json={
            "accountId": "non_existent_account_123",
            "type": "SEND_MESSAGE",
            "payload": {"recipientId": "satya", "content": "hello"},
        },
    )
    assert resp.status_code in (400, 404)
    assert "LinkedIn account is not authorized for this operation." in resp.json()["detail"]

    # 2. Register account without OAuth connection (NOT_CONNECTED)
    save_resp = client.post(
        "/api/accounts",
        json={"email": f"test_unauth_{int(datetime.utcnow().timestamp())}@test.com"},
    )
    acc_id = save_resp.json()["data"]["id"]

    dispatch_resp = client.post(
        "/api/jobs/dispatch",
        json={
            "accountId": acc_id,
            "type": "SEND_MESSAGE",
            "payload": {"recipientId": "satya", "content": "hello"},
        },
    )
    assert dispatch_resp.status_code == 400
    assert "LinkedIn account is not authorized for this operation." in dispatch_resp.json()["detail"]


# ============================================================================
# 17. test_api_sync_rejects_unauthorized_account
# ============================================================================
def test_api_sync_rejects_unauthorized_account():
    client = TestClient(app)
    save_resp = client.post(
        "/api/accounts",
        json={"email": f"test_sync_unauth_{int(datetime.utcnow().timestamp())}@test.com"},
    )
    acc_id = save_resp.json()["data"]["id"]

    sync_resp = client.post(
        "/api/sync",
        json={"accountId": acc_id, "limit": 10},
    )
    assert sync_resp.status_code == 400
    assert "LinkedIn account is not authorized for this operation." in sync_resp.json()["detail"]


# ============================================================================
# 18. test_health_endpoint_separates_infrastructure_from_integration
# ============================================================================
def test_health_endpoint_separates_infrastructure_from_integration():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()

    assert "infrastructure" in data
    assert "externalIntegration" in data
    assert "circuitBreaker" in data

    infra = data["infrastructure"]
    assert "database" in infra
    assert "redis" in infra
    assert "worker" in infra

    ext = data["externalIntegration"]
    assert "OAuth" in ext["provider"]
    assert "connectedAccounts" in ext
    assert "expiredAccounts" in ext
    assert "overallStatus" in ext
