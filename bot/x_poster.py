#!/usr/bin/env python3
"""
X (Twitter) posting bot for Studio Nagoya Base.

Anti-suspension measures:
- Daily post limit (MAX_POSTS_PER_DAY)
- Minimum interval between posts (MIN_INTERVAL_HOURS)
- Random delay before each post (up to MAX_RANDOM_DELAY_MINUTES)
- Duplicate content detection via hash
- Sensitive content flag for R18 posts
- Rate-limit error handling with exponential back-off
"""

import argparse
import hashlib
import json
import os
import random
import time
from datetime import datetime, timedelta

import tweepy
import yaml

# --- Safety limits -------------------------------------------------------
MAX_POSTS_PER_DAY = 3          # never exceed this many posts in one calendar day
MIN_INTERVAL_HOURS = 4         # wait at least this long between posts
MAX_RANDOM_DELAY_MINUTES = 30  # add up to this many minutes of random delay
# -------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(SCRIPT_DIR, "post_log.json")
POSTS_FILE = os.path.join(SCRIPT_DIR, "posts.yaml")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_log() -> dict:
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"posts": [], "daily_counts": {}}


def _save_log(log: dict) -> None:
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2, ensure_ascii=False)


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Rate-limit / safety checks
# ---------------------------------------------------------------------------

def can_post(log: dict) -> bool:
    """Return True only when all safety conditions are met."""
    # 1. Daily limit
    count_today = log["daily_counts"].get(_today(), 0)
    if count_today >= MAX_POSTS_PER_DAY:
        print(f"[SKIP] Daily limit reached ({count_today}/{MAX_POSTS_PER_DAY}).")
        return False

    # 2. Minimum interval
    if log["posts"]:
        last_ts = datetime.fromisoformat(log["posts"][-1]["timestamp"])
        elapsed = datetime.now() - last_ts
        required = timedelta(hours=MIN_INTERVAL_HOURS)
        if elapsed < required:
            next_ok = last_ts + required
            print(f"[SKIP] Too soon. Next post allowed at {next_ok.strftime('%Y-%m-%d %H:%M')}.")
            return False

    return True


def is_duplicate(log: dict, content_hash: str) -> bool:
    posted = {p["content_hash"] for p in log["posts"]}
    return content_hash in posted


# ---------------------------------------------------------------------------
# Content selection
# ---------------------------------------------------------------------------

def load_posts() -> list:
    with open(POSTS_FILE, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data.get("scheduled_posts", [])


def select_post(log: dict, posts: list) -> dict | None:
    """Pick a random post that has not been sent yet."""
    posted_hashes = {p["content_hash"] for p in log["posts"]}
    available = [p for p in posts if _content_hash(p["text"]) not in posted_hashes]
    if not available:
        print("[SKIP] All posts have already been published. Add new content to posts.yaml.")
        return None
    return random.choice(available)


# ---------------------------------------------------------------------------
# Twitter / X client
# ---------------------------------------------------------------------------

def _build_clients():
    """Build Tweepy v2 client (for tweets) and v1.1 API (for media upload)."""
    required = [
        "X_API_KEY",
        "X_API_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_TOKEN_SECRET",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise EnvironmentError(
            f"Missing environment variables: {', '.join(missing)}\n"
            "Set them as repository secrets (see bot/README.md)."
        )

    auth = tweepy.OAuth1UserHandler(
        os.environ["X_API_KEY"],
        os.environ["X_API_SECRET"],
        os.environ["X_ACCESS_TOKEN"],
        os.environ["X_ACCESS_TOKEN_SECRET"],
    )
    api_v1 = tweepy.API(auth, wait_on_rate_limit=True)

    client_v2 = tweepy.Client(
        consumer_key=os.environ["X_API_KEY"],
        consumer_secret=os.environ["X_API_SECRET"],
        access_token=os.environ["X_ACCESS_TOKEN"],
        access_token_secret=os.environ["X_ACCESS_TOKEN_SECRET"],
    )
    return client_v2, api_v1


def _upload_media(api_v1, image_path: str, sensitive: bool) -> int | None:
    """Upload a single image and return its media_id, or None on failure."""
    if not image_path:
        return None
    abs_path = os.path.join(SCRIPT_DIR, image_path) if not os.path.isabs(image_path) else image_path
    if not os.path.exists(abs_path):
        print(f"[WARN] Image not found: {abs_path}")
        return None
    media = api_v1.media_upload(abs_path)
    if sensitive:
        try:
            api_v1.create_media_metadata(
                media.media_id,
                sensitive_media_warning=["adult_content"],
            )
        except Exception as e:
            print(f"[WARN] Could not set sensitive media metadata: {e}")
    return media.media_id


# ---------------------------------------------------------------------------
# Main posting logic
# ---------------------------------------------------------------------------

def post(dry_run: bool = False) -> bool:
    log = _load_log()

    if not can_post(log):
        return False

    posts = load_posts()
    post_content = select_post(log, posts)
    if post_content is None:
        return False

    text = post_content["text"]
    content_hash = _content_hash(text)

    # Extra guard: duplicate check (select_post already filters, but be explicit)
    if is_duplicate(log, content_hash):
        print("[SKIP] Duplicate content detected.")
        return False

    sensitive: bool = post_content.get("sensitive", False)
    images: list = post_content.get("images", [])

    # Random delay — makes posting pattern appear less mechanical
    delay_seconds = random.randint(0, MAX_RANDOM_DELAY_MINUTES * 60)
    print(f"[INFO] Waiting {delay_seconds}s before posting (anti-bot randomisation)…")
    if not dry_run:
        time.sleep(delay_seconds)

    if dry_run:
        print(f"[DRY RUN] Would post (sensitive={sensitive}):\n{text}")
        if images:
            print(f"[DRY RUN] Images: {images}")
        return True

    client_v2, api_v1 = _build_clients()

    # Upload media
    media_ids = []
    for img in images[:4]:  # X allows up to 4 images per tweet
        media_id = _upload_media(api_v1, img, sensitive)
        if media_id:
            media_ids.append(media_id)

    # Post with exponential back-off on rate-limit errors
    tweet_id = None
    for attempt in range(1, 4):
        try:
            params = {"text": text}
            if media_ids:
                params["media_ids"] = media_ids
            response = client_v2.create_tweet(**params)
            tweet_id = str(response.data["id"])
            break
        except tweepy.errors.TooManyRequests as exc:
            wait = 60 * (2 ** attempt)
            print(f"[WARN] Rate limited (attempt {attempt}). Waiting {wait}s… ({exc})")
            time.sleep(wait)
        except tweepy.errors.TweepyException as exc:
            print(f"[ERROR] Failed to post: {exc}")
            return False

    if tweet_id is None:
        print("[ERROR] Giving up after rate-limit retries.")
        return False

    # Persist log
    today = _today()
    log["posts"].append(
        {
            "timestamp": datetime.now().isoformat(),
            "tweet_id": tweet_id,
            "content_hash": content_hash,
            "text_preview": text[:60],
            "sensitive": sensitive,
        }
    )
    log["daily_counts"][today] = log["daily_counts"].get(today, 0) + 1
    _save_log(log)

    print(f"[OK] Posted! Tweet ID: {tweet_id}")
    return True


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="X (Twitter) poster for Studio Nagoya Base — includes anti-suspension measures."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and show what would be posted without actually tweeting.",
    )
    args = parser.parse_args()
    success = post(dry_run=args.dry_run)
    raise SystemExit(0 if success else 1)


if __name__ == "__main__":
    main()
