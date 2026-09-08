import asyncio
import json
import os
import subprocess
import time
import urllib.request
import websockets

try:
    from backend.app.database import get_db_context
    from backend.app.models import LinkedInAccount
    from backend.app.voyager import VoyagerClient
except ImportError:
    import sys
    sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
    from backend.app.database import get_db_context
    from backend.app.models import LinkedInAccount
    from backend.app.voyager import VoyagerClient

CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

USER_DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".chrome_session"))


def find_browser():
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    return None


async def capture_session():
    browser_exe = find_browser()
    if not browser_exe:
        print("❌ Error: Google Chrome or Edge executable not found.")
        return

    print("=" * 65)
    print("  LinkedIn Hyper-V: Automated 1-Click Login & Session Capture")
    print("=" * 65)
    print(f"1. Launching browser ({os.path.basename(browser_exe)})...")

    proc = subprocess.Popen([
        browser_exe,
        "--remote-debugging-port=9222",
        f"--user-data-dir={USER_DATA_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "https://www.linkedin.com/login",
    ])

    ws_url = None
    print("2. Connecting to browser DevTools interface...")
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://localhost:9222/json", timeout=2) as resp:
                data = json.loads(resp.read().decode())
                for target in data:
                    if target.get("type") == "page":
                        ws_url = target.get("webSocketDebuggerUrl")
                        break
                if ws_url:
                    break
        except Exception:
            time.sleep(0.5)

    if not ws_url:
        print("❌ Failed to attach to browser window.")
        proc.kill()
        return

    print("\n👉 A browser window has opened with LinkedIn Login.")
    print("👉 Please LOG IN to your LinkedIn account on that window.")
    print("   (Enter email & password or sign in with Google)\n")
    print("⏳ Waiting for successful login (detecting active session)...")

    captured_cookies = {}
    async with websockets.connect(ws_url) as ws:
        while True:
            try:
                # Query cookies from LinkedIn domain
                msg = json.dumps({
                    "id": int(time.time() * 1000) % 100000,
                    "method": "Network.getCookies",
                    "params": {"urls": ["https://www.linkedin.com", "https://www.linkedin.com/feed/"]},
                })
                await ws.send(msg)
                resp = await ws.recv()
                result = json.loads(resp)
                cookies_list = result.get("result", {}).get("cookies", [])

                cookie_map = {c["name"]: c["value"] for c in cookies_list}
                li_at = cookie_map.get("li_at")

                if li_at and len(li_at) >= 50 and li_at != "delete me":
                    print("\n✓ Active 'li_at' session token detected!")
                    captured_cookies = cookie_map
                    break

            except Exception as e:
                pass

            await asyncio.sleep(1.5)

    li_at = captured_cookies.get("li_at")
    jsessionid = captured_cookies.get("JSESSIONID", "").strip('"')

    print("3. Validating session directly with LinkedIn Voyager API...")
    temp_account = LinkedInAccount(
        email="probe@linkedin.com",
        cookies=captured_cookies,
    )
    client = VoyagerClient()
    try:
        res = client.verify_session(temp_account)
        pub_id = res.get("publicIdentifier") or "Unknown"
        plain_id = str(res.get("plainId") or "")
        print(f"✓ Verification Success! Logged in as: {pub_id} (Member ID: {plain_id})")
    except Exception as e:
        print(f"⚠️ Verification note: {e}")
        pub_id = None
        plain_id = None

    print("4. Storing authorized session in LinkedIn Hyper-V database...")
    with get_db_context() as db:
        # Find active account (prefer arunj5687@gmail.com or matching email)
        target_account = (
            db.query(LinkedInAccount)
            .filter(LinkedInAccount.email.in_(["arunj5687@gmail.com", "www.jadhavarun2004@gmail.com"]))
            .first()
        )

        if not target_account:
            target_account = db.query(LinkedInAccount).first()

        if target_account:
            target_account.status = "ACTIVE"
            target_account.cookies = captured_cookies
            if pub_id:
                target_account.publicIdentifier = pub_id
            if plain_id:
                target_account.linkedinId = plain_id
            db.commit()
            print(f"\n🎉 SUCCESS! Account '{target_account.email}' is now AUTHORIZED!")
            print("   Status updated to ACTIVE with live session cookies.")
            print("   You can now open http://localhost:3000 and start messaging or sending connection requests!")
        else:
            print("❌ No account found in DB to link.")

    print("\nKeep the browser window open or minimized while using Hyper-V.")


if __name__ == "__main__":
    asyncio.run(capture_session())
