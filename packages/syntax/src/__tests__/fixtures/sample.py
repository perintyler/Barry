#!/usr/bin/env python3
"""
Fetch and categorize PR review feedback.

Usage:
    python fetch_pr_feedback.py [--pr PR_NUMBER]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Any

# Bots that provide actionable code review feedback
REVIEW_BOT_PATTERNS = [
    r"(?i)^sentry",
    r"(?i)^warden",
    r"(?i)^cursor",
    r"(?i)^bugbot",
]

INFO_BOT_PATTERNS = [
    r"(?i)^codecov",
    r"(?i)^dependabot",
    r"(?i)\[bot\]$",
]


def run_gh(args: list[str]) -> dict[str, Any] | list[Any] | None:
    """Run a gh CLI command and return parsed JSON output."""
    cmd = ["gh"] + args + ["--json"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except subprocess.CalledProcessError as e:
        print(f"Error running gh: {e.stderr}", file=sys.stderr)
        return None


@dataclass
class Feedback:
    category: str
    author: str
    body: str
    review_bot: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "author": self.author,
            "body": self.body,
            "review_bot": self.review_bot,
        }


def is_review_bot(author: str) -> bool:
    return any(re.match(p, author) for p in REVIEW_BOT_PATTERNS)


def categorize(text: str, state: str = "open") -> str:
    if state == "resolved":
        return "resolved"
    lower = text.lower()
    if lower.startswith("h:") or "blocker" in lower:
        return "high"
    if lower.startswith("m:"):
        return "medium"
    if lower.startswith(("l:", "nit")):
        return "low"
    return "medium"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pr", type=int, help="PR number")
    args = parser.parse_args()
    print(json.dumps({"status": "ok", "count": 0}))
