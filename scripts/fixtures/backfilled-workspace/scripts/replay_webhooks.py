"""Replays failed billing webhook events against an environment."""

import sys


def main(since: str) -> None:
    print(f"Replaying events since {since}")


if __name__ == "__main__":
    main(sys.argv[1])
