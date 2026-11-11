"""The version the adapters record (`adapter.version`) is the version the wheel is built as."""

import re
from pathlib import Path

import testivai


def test_package_version_matches_pyproject():
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    declared = re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE).group(1)
    assert testivai.__version__ == declared
