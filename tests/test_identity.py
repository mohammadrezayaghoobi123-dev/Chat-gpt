import unittest

from master_brain.identity import Identity, MIN_TOKEN_CHARS, StaticTokenAuthenticator

TOKEN = "t" * MIN_TOKEN_CHARS


class IdentityTests(unittest.TestCase):
    def test_valid_token_maps_to_subject_and_others_do_not(self):
        auth = StaticTokenAuthenticator({TOKEN: "user:alice", "u" * 40: "user:bob"})
        self.assertEqual(auth.authenticate(TOKEN), Identity("user:alice"))
        self.assertEqual(auth.authenticate("u" * 40), Identity("user:bob"))
        for bad in (None, "", " ", TOKEN + "x", TOKEN[:-1], TOKEN.upper(), 5, b"x", "\ud800" * 40, "t" * 513,
                    " " + TOKEN):
            with self.subTest(bad=bad):
                self.assertIsNone(auth.authenticate(bad))

    def test_construction_rejects_weak_or_duplicate_tokens_and_bad_subjects(self):
        for tokens in ({}, {"short": "u"}, {TOKEN + " ": "u"}, {5: "u"}, {TOKEN: ""}, {TOKEN: "bad subject"},
                       {TOKEN: "u" * 129}, {TOKEN: None}):
            with self.subTest(tokens=tokens), self.assertRaises((ValueError, TypeError)):
                StaticTokenAuthenticator(tokens)
        with self.assertRaises(ValueError):
            Identity("")
        with self.assertRaises(ValueError):
            StaticTokenAuthenticator({TOKEN: "ok", "u" * 40: ""})

    def test_minimum_length_is_exactly_32_and_identity_is_immutable(self):
        StaticTokenAuthenticator({"x" * 32: "u"})
        with self.assertRaises(ValueError):
            StaticTokenAuthenticator({"x" * 31: "u"})
        long = StaticTokenAuthenticator({"y" * 512: "u"})
        self.assertEqual(long.authenticate("y" * 512), Identity("u"))
        self.assertIsNone(long.authenticate("y" * 513))
        over = StaticTokenAuthenticator({"z" * 513: "u"})  # even a configured token cannot exceed the cap
        self.assertIsNone(over.authenticate("z" * 513))
        self.assertEqual(MIN_TOKEN_CHARS, 32)
        with self.assertRaises(Exception):
            Identity("u").subject = "v"

    def test_tokens_are_not_retained_in_clear(self):
        auth = StaticTokenAuthenticator({TOKEN: "user:alice"})
        self.assertNotIn(TOKEN, repr(vars(auth)))
        self.assertNotIn(TOKEN.encode(), repr(vars(auth)).encode())


if __name__ == "__main__":
    unittest.main()
