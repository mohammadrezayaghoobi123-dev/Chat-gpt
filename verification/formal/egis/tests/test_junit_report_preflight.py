"""Hostile behavior tests for the JUnit report-root preflight."""
import json
from pathlib import Path
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import egis_junit_report_preflight as p


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "target").mkdir()
        (self.root / "customBuild.xml").write_text("<project/>", encoding="utf-8")
        self.props = {"basedir": str(self.root), "test.reports": "target/surefire-reports/",
                      "maven.test.skip": "false", "maven.test.halt": "true", "test.halt": "true"}
        self.build = str(self.root / "customBuild.xml")

    def tearDown(self):
        self.tmp.cleanup()

    def run_check(self, props=None, args=(), env=None):
        return p.preflight_report_roots(self.root, ant_properties=props or self.props,
                                        ant_arguments=("-f", self.build, *args), environment=env or {})

    def test_pass_is_read_only_and_roots_are_disjoint(self):
        r = self.run_check()
        self.assertEqual("PASS", r["status"])
        self.assertEqual("NONE", r["side_effects"])
        self.assertFalse((self.root / "target/surefire-reports").exists())
        self.assertFalse(Path(r["source_report_root"]).is_relative_to(Path(r["packaged_jar_report_root"])))

    def test_stale_report_is_blocked_and_never_deleted(self):
        folder = self.root / "target/surefire-reports"
        folder.mkdir()
        old = folder / "old.xml"
        old.write_text("keep", encoding="utf-8")
        r = self.run_check()
        self.assertEqual("report_root_already_exists", r["reason"])
        self.assertEqual("keep", old.read_text(encoding="utf-8"))

    def test_bad_report_path_and_skip_or_halt_properties_block(self):
        variants = [
            {**self.props, "test.reports": "../outside"},
            {**self.props, "test.reports": str(self.root / "target/surefire-reports")},
            {**self.props, "maven.test.skip": "true"},
            {**self.props, "maven.test.halt": "false"},
            {**self.props, "test.halt": "false"},
            {**self.props, "noclean": "false"},
            {**self.props, "test.skip": "false"},
        ]
        for properties in variants:
            with self.subTest(properties=properties):
                self.assertEqual("BLOCKED", self.run_check(props=properties)["status"])

    def test_basedir_must_be_exact_checkout(self):
        r = self.run_check(props={**self.props, "basedir": str(self.root / "elsewhere")})
        self.assertEqual("effective_basedir_unavailable", r["reason"])

    def test_absolute_buildfile_is_required_and_search_or_substitution_blocks(self):
        for args in (("-f", "customBuild.xml"), ("-find", "customBuild.xml"),
                     ("-s", "customBuild.xml"), ("-f", str(self.root / "other.xml"))):
            with self.subTest(args=args):
                r = p.preflight_report_roots(self.root, ant_properties=self.props, ant_arguments=args, environment={})
                self.assertEqual("BLOCKED", r["status"])

    def test_propertyfile_and_conflicting_D_overrides_block(self):
        for args in (("-propertyfile", "external.properties"), ("-Dnoclean=false",),
                     ("-Dtest.skip=false",), ("-Dbasedir=/tmp/other",), ("-Dtest.reports=../outside",),
                     ("-Dmaven.test.skip=true",)):
            with self.subTest(args=args):
                self.assertEqual("BLOCKED", self.run_check(args=args)["status"])

    def test_exact_redundant_report_override_is_allowed(self):
        r = self.run_check(args=("-Dtest.reports=target/surefire-reports/",))
        self.assertEqual("PASS", r["status"])
        self.assertEqual(["test.reports"], r["controlled_launcher_overrides_checked"])

    def test_launcher_environment_rejects_property_and_jvm_injection(self):
        cases = (("ANT_ARGS", "-Dnoclean=false"), ("ANT_ARGS", "-propertyfile x.properties"),
                 ("ANT_OPTS", "-javaagent:/tmp/agent.jar"),
                 ("JAVA_TOOL_OPTIONS", "-agentlib:jdwp=transport=dt_socket"),
                 ("JDK_JAVA_OPTIONS", "-Xbootclasspath/p:/tmp/evil.jar"),
                 ("_JAVA_OPTIONS", "--patch-module=java.base=/tmp/patch"))
        for name, value in cases:
            with self.subTest(name=name):
                self.assertEqual("BLOCKED", self.run_check(env={name: value})["status"])

    def test_ant_extensions_and_wrapper_hooks_block(self):
        for args in (("-listener", "evil.Listener"), ("-logger", "evil.Logger"),
                     ("-inputhandler", "evil.Input"), ("-lib", "/tmp/evil"), ("-autoproxy",)):
            with self.subTest(args=args):
                self.assertEqual("BLOCKED", self.run_check(args=args)["status"])
        home = self.root / "home"
        home.mkdir()
        (home / ".antrc").write_text("ANT_ARGS=-Dnoclean=false", encoding="utf-8")
        r = self.run_check(env={"HOME": str(home)})
        self.assertEqual("external_ant_wrapper_hook_present", r["reason"])

    def test_symlink_and_windows_reparse_components_block(self):
        target = self.root / "target"
        target.rename(self.root / "real-target")
        target.symlink_to(self.root / "real-target", target_is_directory=True)
        self.assertEqual("BLOCKED", self.run_check()["status"])
        target.unlink()
        target.mkdir()
        original = p.os.lstat
        def fake(path):
            if Path(path) == target:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0x400)
            return original(path)
        with patch.object(p.os, "lstat", side_effect=fake):
            r = self.run_check()
        self.assertEqual("symlink_path_component", r["reason"])

    def test_missing_or_symlinked_buildfile_blocks(self):
        build = self.root / "customBuild.xml"
        build.unlink()
        self.assertEqual("BLOCKED", self.run_check()["status"])
        other = self.root.parent / (self.root.name + "-other.xml")
        other.write_text("<project/>", encoding="utf-8")
        build.symlink_to(other)
        try:
            self.assertEqual("BLOCKED", self.run_check()["status"])
        finally:
            other.unlink(missing_ok=True)

    def test_uncontrolled_values_are_not_echoed(self):
        r = self.run_check(args=("-Dcustom.secret=never-echo",))
        self.assertEqual("PASS", r["status"])
        self.assertNotIn("never-echo", json.dumps(r))


if __name__ == "__main__":
    unittest.main(verbosity=2)
