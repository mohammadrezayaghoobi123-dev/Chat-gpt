from pathlib import Path
import unittest

WORKFLOW = Path(".github/workflows/master-brain-tests.yml").read_text(encoding="utf-8")
KERNEL_STEP = WORKFLOW.split("- name: Kernel-enforced limits", 1)[1].split("\n      - name:", 1)[0]


class KernelEnforcementWorkflowContractTests(unittest.TestCase):
    def test_kernel_test_pipeline_propagates_command_failures(self):
        self.assertIn("shell: bash", KERNEL_STEP)
        self.assertIn("set -euo pipefail", KERNEL_STEP)

    def test_kernel_skip_guard_fails_closed(self):
        self.assertRegex(KERNEL_STEP, r'if grep -q "skipped" kernel-out\.txt; then')
        self.assertNotRegex(KERNEL_STEP, r'grep -q "skipped" kernel-out\.txt.*\|\|\s*true')


if __name__ == "__main__":
    unittest.main()
