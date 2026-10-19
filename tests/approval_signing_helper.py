"""Shared stdlib-only signer/verifier pair for tests (algorithm-agnostic seam; not production)."""
import hashlib
import hmac

TEST_ALGORITHM = "test-hmac-sha256"


class HmacSeamSigner:
    algorithm = TEST_ALGORITHM

    def __init__(self, key_id, secret):
        self.key_id, self._secret = key_id, secret

    def sign(self, message):
        return hmac.new(self._secret, message, hashlib.sha256).digest()


class HmacSeamVerifier:
    def __init__(self):
        self.keys, self.revoked, self.calls = {}, set(), 0

    def add(self, key_id, secret, subject):
        self.keys[key_id] = (secret, subject)

    def verify(self, *, key_id, algorithm, subject, message, signature):
        self.calls += 1
        if algorithm != TEST_ALGORITHM:
            return "unsupported algorithm"
        if key_id not in self.keys:
            return "unknown key"
        if key_id in self.revoked:
            return "key revoked"
        secret, bound = self.keys[key_id]
        if bound != subject:
            return "key not bound to this approver"
        good = hmac.new(secret, message, hashlib.sha256).digest()
        return None if hmac.compare_digest(good, signature) else "bad signature"


def trusted_pair(subject="user:reviewer", key_id="k-test", secret=b"test-secret"):
    """(signer, verifier) where the verifier trusts the signer's key for ``subject``."""
    verifier = HmacSeamVerifier()
    verifier.add(key_id, secret, subject)
    return HmacSeamSigner(key_id, secret), verifier
