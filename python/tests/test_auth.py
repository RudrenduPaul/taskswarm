from taskswarm.server.auth import extract_bearer_token, tokens_match


def test_tokens_match_identical():
    assert tokens_match("abc123", "abc123") is True


def test_tokens_match_different():
    assert tokens_match("abc123", "abc124") is False


def test_tokens_match_different_lengths():
    assert tokens_match("short", "a-much-longer-token") is False


def test_extract_bearer_token_present():
    assert extract_bearer_token("Bearer abc123") == "abc123"


def test_extract_bearer_token_case_insensitive():
    assert extract_bearer_token("bearer abc123") == "abc123"


def test_extract_bearer_token_missing_header():
    assert extract_bearer_token(None) is None


def test_extract_bearer_token_wrong_scheme():
    assert extract_bearer_token("Basic abc123") is None


def test_extract_bearer_token_empty_string():
    assert extract_bearer_token("") is None
