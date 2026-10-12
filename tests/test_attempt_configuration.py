import unittest
from types import SimpleNamespace
from unittest.mock import patch

from master_brain.attempt_configuration import (
    AttemptConfigurationError,
    AttemptScopeDescriptor,
    ConfiguredAttemptScopeRegistry,
    load_deployment_attempt_scope_registry,
    reserve_configured_attempt,
)


class ConfiguredAttemptScopeRegistryTests(unittest.TestCase):
    def setUp(self):
        self.descriptor = AttemptScopeDescriptor(
            integration_id="payments-v1",
            adapter_version="1.0",
            provider_id="provider-x",
            provider_scope="merchant-account-1/production",
            receipt_namespace="operation-receipt",
        )

    def test_resolves_exact_tuple_and_returns_deployment_owned_scope(self):
        registry = ConfiguredAttemptScopeRegistry([self.descriptor])
        self.assertEqual(
            registry.resolve(
                integration_id="payments-v1",
                adapter_version="1.0",
                provider_id="provider-x",
            ),
            self.descriptor,
        )

    def test_unknown_or_disabled_tuple_fails_closed(self):
        registry = ConfiguredAttemptScopeRegistry([
            AttemptScopeDescriptor(
                integration_id="payments-v1", adapter_version="1.0",
                provider_id="provider-x", provider_scope="acct/prod",
                receipt_namespace="receipt", enabled=False,
            )
        ])
        with self.assertRaises(AttemptConfigurationError):
            registry.resolve(
                integration_id="payments-v1",
                adapter_version="1.0",
                provider_id="provider-x",
            )

    def test_duplicate_tuple_fails_closed(self):
        with self.assertRaisesRegex(AttemptConfigurationError, "duplicate"):
            ConfiguredAttemptScopeRegistry([self.descriptor, self.descriptor])

    def test_malformed_descriptor_fails_closed(self):
        with self.assertRaisesRegex(AttemptConfigurationError, "invalid type"):
            ConfiguredAttemptScopeRegistry([object()])

    def test_missing_deployment_module_fails_closed(self):
        with patch(
            "master_brain.attempt_configuration.importlib.import_module",
            side_effect=ModuleNotFoundError(
                "missing", name="master_brain.deployment_attempt_config"
            ),
        ):
            with self.assertRaisesRegex(
                AttemptConfigurationError, "configuration is unavailable"
            ):
                load_deployment_attempt_scope_registry()

    def test_import_failure_is_sanitized(self):
        secret = "token=must-not-leak"
        with patch(
            "master_brain.attempt_configuration.importlib.import_module",
            side_effect=RuntimeError(secret),
        ):
            with self.assertRaisesRegex(
                AttemptConfigurationError, "could not be loaded"
            ) as caught:
                load_deployment_attempt_scope_registry()
        self.assertNotIn(secret, str(caught.exception))

    def test_configured_reservation_does_not_accept_caller_scope_values(self):
        class RegistryStub:
            def reserve_attempt(self, **kwargs):
                return kwargs

        result = reserve_configured_attempt(
            RegistryStub(),
            key="exec-1",
            expected_version=2,
            integration_id="payments-v1",
            adapter_version="1.0",
            provider_id="provider-x",
            recorded_at="2026-10-12T10:00:00+00:00",
            scope_registry=ConfiguredAttemptScopeRegistry([self.descriptor]),
        )
        self.assertEqual(result["provider_scope"], "merchant-account-1/production")
        self.assertEqual(result["receipt_namespace"], "operation-receipt")
        self.assertNotIn("caller_scope", result)


if __name__ == "__main__":
    unittest.main()
