import unittest

from master_brain.verifier_registry import (
    ConfiguredVerifierRegistry,
    VerifierDescriptor,
    VerifierRegistryError,
)


def verify_receipt(_evidence):
    return True


class ConfiguredVerifierRegistryTests(unittest.TestCase):
    def descriptor(self, **overrides):
        values = {
            "verifier_id": "payments-receipt",
            "version": "1",
            "provider_id": "provider-x",
            "evidence_type": "operation-receipt",
            "verify": verify_receipt,
            "enabled": True,
        }
        values.update(overrides)
        return VerifierDescriptor(**values)

    def test_resolves_exact_approved_tuple(self):
        registry = ConfiguredVerifierRegistry([self.descriptor()])
        self.assertIs(
            registry.resolve(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
            ),
            verify_receipt,
        )

    def test_unknown_version_fails_closed(self):
        registry = ConfiguredVerifierRegistry([self.descriptor()])
        with self.assertRaises(VerifierRegistryError):
            registry.resolve(
                verifier_id="payments-receipt",
                version="2",
                provider_id="provider-x",
                evidence_type="operation-receipt",
            )

    def test_provider_and_evidence_type_are_part_of_lookup_key(self):
        registry = ConfiguredVerifierRegistry([self.descriptor()])
        for kwargs in (
            {"provider_id": "provider-y"},
            {"evidence_type": "generic-receipt"},
        ):
            request = {
                "verifier_id": "payments-receipt",
                "version": "1",
                "provider_id": "provider-x",
                "evidence_type": "operation-receipt",
            }
            request.update(kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaises(VerifierRegistryError):
                registry.resolve(**request)

    def test_disabled_verifier_fails_closed(self):
        registry = ConfiguredVerifierRegistry([self.descriptor(enabled=False)])
        with self.assertRaises(VerifierRegistryError):
            registry.resolve(
                verifier_id="payments-receipt",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
            )

    def test_duplicate_configuration_fails_closed(self):
        item = self.descriptor()
        with self.assertRaisesRegex(VerifierRegistryError, "duplicate"):
            ConfiguredVerifierRegistry([item, item])

    def test_invalid_descriptor_fails_closed(self):
        with self.assertRaisesRegex(VerifierRegistryError, "callable"):
            ConfiguredVerifierRegistry([self.descriptor(verify=None)])

    def test_empty_lookup_fields_fail_closed(self):
        registry = ConfiguredVerifierRegistry([self.descriptor()])
        with self.assertRaises(VerifierRegistryError):
            registry.resolve(
                verifier_id="",
                version="1",
                provider_id="provider-x",
                evidence_type="operation-receipt",
            )


class DeploymentVerifierConfigurationValidationTests(unittest.TestCase):
    def _load_from_module(self, descriptors):
        from types import SimpleNamespace
        from unittest.mock import patch
        from master_brain.verifier_registry import load_deployment_verifier_registry

        module = SimpleNamespace(VERIFIER_DESCRIPTORS=descriptors)
        with patch.dict(
            "sys.modules", {"master_brain.deployment_verifiers": module}
        ):
            return load_deployment_verifier_registry()

    def test_empty_deployment_configuration_fails_closed(self):
        with self.assertRaisesRegex(
            VerifierRegistryError, "must provide at least one verifier"
        ):
            self._load_from_module([])

    def test_malformed_deployment_descriptor_fails_closed(self):
        with self.assertRaisesRegex(VerifierRegistryError, "descriptor has invalid type"):
            self._load_from_module([object()])

    def test_duplicate_deployment_entries_fail_closed(self):
        descriptor = VerifierDescriptor(
            verifier_id="payments-receipt",
            version="1",
            provider_id="provider-x",
            evidence_type="operation-receipt",
            verify=verify_receipt,
        )
        with self.assertRaisesRegex(VerifierRegistryError, "duplicate"):
            self._load_from_module([descriptor, descriptor])


if __name__ == "__main__":
    unittest.main()


class DeploymentVerifierConfigurationTests(unittest.TestCase):
    def test_missing_reviewed_deployment_configuration_fails_closed(self):
        from master_brain.verifier_registry import (
            load_deployment_verifier_registry,
        )

        with self.assertRaisesRegex(
            VerifierRegistryError, "deployment verifier configuration is unavailable"
        ):
            load_deployment_verifier_registry()


