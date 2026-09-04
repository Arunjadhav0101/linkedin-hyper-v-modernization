import pytest
import hashlib
from unittest.mock import MagicMock, patch
try:
    from backend.app.models import LinkedInAccount, AutomationJob, Conversation, ChatMessage
    from backend.app.voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError
    from backend.app.worker import JobProcessor
except ImportError:
    from app.models import LinkedInAccount, AutomationJob, Conversation, ChatMessage
    from app.voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError
    from app.worker import JobProcessor


def test_validate_session_rejects_missing_or_short_token():
    account_no_cookie = LinkedInAccount(email="test@test.com", cookies={})
    with pytest.raises(MissingIntegrationError, match="Missing required 'li_at'"):
        VoyagerClient.validate_session(account_no_cookie)

    account_short_cookie = LinkedInAccount(email="test@test.com", cookies={"li_at": "Arun1234"})
    with pytest.raises(MissingIntegrationError, match="is only 8 characters"):
        VoyagerClient.validate_session(account_short_cookie)

    account_valid = LinkedInAccount(
        email="test@test.com",
        cookies={"li_at": "AQED_TEST_VALID_SESSION_TOKEN_LONGER_THAN_50_CHARS_1234567890", "JSESSIONID": "ajax:123"},
    )
    li_at, jsession = VoyagerClient.validate_session(account_valid)
    assert li_at.startswith("AQED")
    assert jsession == "ajax:123"


def test_self_action_guard_prevents_inviting_own_profile():
    client = VoyagerClient()
    account = LinkedInAccount(
        email="user@company.com",
        publicIdentifier="arun-jadhav-a80222318",
        linkedinId="12345678",
        cookies={"li_at": "AQED_TEST_VALID_SESSION_TOKEN_LONGER_THAN_50_CHARS_1234567890"},
    )

    # Inviting own vanity name
    with pytest.raises(ValidationError, match="Cannot send connection request to your own profile"):
        client.send_connection_request(account, "arun-jadhav-a80222318")

    # Inviting own URL
    with pytest.raises(ValidationError, match="Cannot send connection request to your own profile"):
        client.send_connection_request(account, "https://www.linkedin.com/in/arun-jadhav-a80222318/")

    # Messaging own profile
    with pytest.raises(ValidationError, match="Cannot send message to your own profile"):
        client.send_message(account, "arun-jadhav-a80222318", "Hello self")


def test_error_classifier_identifies_permanent_vs_transient():
    # Permanent errors (must NOT retry)
    assert JobProcessor.is_permanent_error(ValidationError("Self action")) is True
    assert JobProcessor.is_permanent_error(MissingIntegrationError("No cookie")) is True
    assert JobProcessor.is_permanent_error(VoyagerApiError(401, "Unauthorized")) is True
    assert JobProcessor.is_permanent_error(VoyagerApiError(404, "Not Found")) is True
    assert JobProcessor.is_permanent_error(VoyagerApiError(422, "Unprocessable Entity")) is True

    # Transient errors (should retry)
    assert JobProcessor.is_permanent_error(VoyagerApiError(500, "Internal Server Error")) is False
    assert JobProcessor.is_permanent_error(VoyagerApiError(502, "Bad Gateway")) is False
    assert JobProcessor.is_permanent_error(Exception("Connection reset by peer")) is False


def test_idempotent_message_key_generation():
    account_id = "acc_123"
    conv_id = "conv_456"
    msg_id = "remote_msg_789"

    key1 = hashlib.sha256(f"{account_id}:{conv_id}:{msg_id}".encode()).hexdigest()
    key2 = hashlib.sha256(f"{account_id}:{conv_id}:{msg_id}".encode()).hexdigest()

    assert key1 == key2
    assert len(key1) == 64


def test_job_processor_terminates_permanent_error_immediately():
    processor = JobProcessor()
    db = MagicMock()

    account = LinkedInAccount(
        id="acc_test",
        email="test@test.com",
        cookies={"li_at": "AQED_TEST_VALID_SESSION_TOKEN_LONGER_THAN_50_CHARS_1234567890"},
    )
    job = AutomationJob(
        id="job_perm_test",
        traceId="trace_perm",
        accountId="acc_test",
        type="SEND_CONNECTION_REQUEST",
        payload={"targetProfileId": "target_user"},
        status="QUEUED",
        retryCount=0,
        maxRetries=5,
    )

    db.query.return_value.filter.return_value.first.return_value = account

    # Mock voyager to throw 422
    with patch.object(processor.voyager, "send_connection_request", side_effect=VoyagerApiError(422, "Unprocessable")):
        with patch.object(processor, "acquire_lock", return_value=True):
            with patch.object(processor, "release_lock"):
                processor.execute_job(db, job)

    assert job.status == "FAILED"
    assert job.retryCount == 0  # Zero retries! Did NOT retry 5 times
    assert "422" in job.errorMessage


def test_job_processor_retries_transient_error_with_backoff():
    processor = JobProcessor()
    db = MagicMock()

    account = LinkedInAccount(
        id="acc_test",
        email="test@test.com",
        cookies={"li_at": "AQED_TEST_VALID_SESSION_TOKEN_LONGER_THAN_50_CHARS_1234567890"},
    )
    job = AutomationJob(
        id="job_transient_test",
        traceId="trace_trans",
        accountId="acc_test",
        type="SEND_MESSAGE",
        payload={"recipientId": "satya", "content": "Hi Satya"},
        status="QUEUED",
        retryCount=0,
        maxRetries=3,
    )

    db.query.return_value.filter.return_value.first.return_value = account

    # Mock voyager to throw network error
    with patch.object(processor.voyager, "send_message", side_effect=Exception("Connection timed out")):
        with patch.object(processor, "acquire_lock", return_value=True):
            with patch.object(processor, "release_lock"):
                processor.execute_job(db, job)

    assert job.status == "RETRYING"
    assert job.retryCount == 1
    assert "Connection timed out" in job.errorMessage
