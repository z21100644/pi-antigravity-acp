#!/usr/bin/env python3
"""Antigravity context-unlock autopatcher.

Watches for freshly installed (still vanilla) Antigravity binaries and unlocks
their context-window gates automatically. The script is built to be a no-op
whenever nothing changed:

  * it only writes after a --dry-run proves the on-disk binary is vanilla;
  * it only signals a language_server right after patching that same binary,
    which is the post-update hot-reload path.

Standard library only. Runs from launchd or from the zsh fallback guard.
"""

import argparse
import errno
import fcntl
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime

HOME = os.path.expanduser("~")
CACHE_DIR = os.path.join(HOME, ".cache", "agy-unlock")
LOCK_PATH = os.path.join(CACHE_DIR, "autopatch.lock")
LOG_PATH = os.path.join(CACHE_DIR, "autopatch.log")
PATCHER = os.path.join(HOME, ".gemini", "antigravity", "tools", "agy-patch.py")

CLI_BIN = os.path.join(HOME, ".local", "bin", "agy")
APP_LS = "/Applications/Antigravity.app/Contents/Resources/bin/language_server"

CLI_STAMP = os.path.join(CACHE_DIR, "cli.stamp")
DESKTOP_STAMP = os.path.join(CACHE_DIR, "desktop.stamp")

PGREP = "/usr/bin/pgrep"

SHIPIT_WAIT_SECONDS = 20.0
HOT_RELOAD_WAIT_SECONDS = 8.0
POLL_INTERVAL = 0.5

# launchd hands us a minimal PATH; codesign/pgrep live in /usr/bin anyway.
PATCH_ENV = dict(os.environ)
PATCH_ENV["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"

APP_LS_PATTERN = "^" + re.escape(APP_LS)


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def log(message):
    line = "[%s] %s" % (now_iso(), message)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            fh.flush()
    except OSError:
        pass
    print(line, flush=True)


def acquire_lock():
    """Exclusive, non-blocking lock so overlapping launchd/event runs bail out."""
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    except OSError as exc:
        log("lock: cannot open %s: %s" % (LOCK_PATH, exc))
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    try:
        os.ftruncate(fd, 0)
        os.write(fd, ("%d\n" % os.getpid()).encode("ascii"))
    except OSError:
        pass
    return fd


def probe_write_access(path):
    """Ask the kernel whether this process may write the app binary.

    Opening O_RDWR writes zero bytes: mtime, contents and code signature are
    untouched. It is the cheapest way to observe the TCC App Management gate.
    """
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError as exc:
        if exc.errno in (errno.EPERM, errno.EACCES):
            return "eperm", "%d: %s" % (exc.errno, exc.strerror)
        return "error", "%d: %s" % (exc.errno, exc.strerror)
    try:
        os.close(fd)
    except OSError:
        pass
    return "ok", None


def run_patcher(binary, *extra_args):
    cmd = [sys.executable, PATCHER, "--binary", binary] + list(extra_args)
    log("run: %s" % " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            env=PATCH_ENV,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log("patcher could not run: %s" % exc)
        return None
    output = (proc.stdout or "") + (proc.stderr or "")
    for line in output.strip().splitlines():
        log("  | %s" % line)
    if proc.returncode != 0:
        log("patcher exit=%d" % proc.returncode)
        return None
    return output


def stamp_is_stale(stamp, binary):
    try:
        return os.path.getmtime(stamp) < os.path.getmtime(binary)
    except OSError:
        return True


def refresh_stamp(stamp, binary):
    try:
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write("updated=%s\nbinary=%s\nmtime_ns=%d\n"
                     % (now_iso(), binary, os.stat(binary).st_mtime_ns))
            fh.flush()
            os.fsync(fh.fileno())
        os.utime(stamp, None)
        log("stamp: refreshed %s" % stamp)
    except OSError as exc:
        log("stamp: cannot write %s: %s" % (stamp, exc))


def pgrep_pids(*args):
    try:
        proc = subprocess.run(
            [PGREP] + list(args), capture_output=True, text=True, timeout=10
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [p for p in proc.stdout.split() if p.isdigit()]


APP_MAIN_PATTERN = "^" + re.escape("/Applications/Antigravity.app/Contents/MacOS/Antigravity")


def wait_for_shipit():
    """ShipIt is mid-swap only while Antigravity.app main process is exited."""
    pids = pgrep_pids("-x", "ShipIt")
    if not pids or pgrep_pids("-f", APP_MAIN_PATTERN):
        return True
    log("shipit: mid-swap (pid %s); waiting up to %.0fs"
        % (", ".join(pids), SHIPIT_WAIT_SECONDS))
    deadline = time.time() + SHIPIT_WAIT_SECONDS
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL)
        if not pgrep_pids("-x", "ShipIt"):
            log("shipit: finished; continuing")
            return True
    log("shipit: still running after %.0fs; continuing carefully"
        % SHIPIT_WAIT_SECONDS)
    return False


def check_cli():
    if not os.path.exists(CLI_BIN):
        log("cli: %s not present; skip" % CLI_BIN)
        return

    output = run_patcher(CLI_BIN, "--dry-run")
    if output is None:
        log("cli: dry run failed; left untouched")
        return

    if "dry run complete:" in output:
        log("cli: fresh unpatched binary detected; patching in place")
        result = run_patcher(CLI_BIN, "--in-place")
        if result is None:
            log("cli: patch FAILED; stamp left stale for retry")
            return
        refresh_stamp(CLI_STAMP, CLI_BIN)
        log("cli: patched")
    elif "all gates already unlocked" in output:
        if stamp_is_stale(CLI_STAMP, CLI_BIN):
            refresh_stamp(CLI_STAMP, CLI_BIN)
        else:
            log("cli: already unlocked; stamp current")
    else:
        log("cli: unrecognised dry-run result; left untouched")


def running_app_ls_pids():
    return pgrep_pids("-f", APP_LS_PATTERN)


def hot_reload():
    """Kill the freshly launched vanilla language_server once.

    Electron's monitorLsCrashInternal respawns it after its 2s cooldown, now
    from the patched on-disk binary.
    """
    deadline = time.time() + HOT_RELOAD_WAIT_SECONDS
    pids = []
    while time.time() < deadline:
        pids = running_app_ls_pids()
        if pids:
            break
        time.sleep(POLL_INTERVAL)

    if not pids:
        log("desktop: no running language_server within %.0fs; on-disk patch "
            "will take effect at next launch" % HOT_RELOAD_WAIT_SECONDS)
        return

    log("desktop: hot-reload target pid %s; sending one SIGTERM each"
        % ", ".join(pids))
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
            log("desktop: SIGTERM sent to pid %s for hot reload" % pid)
        except OSError as exc:
            log("desktop: SIGTERM pid %s failed: %s" % (pid, exc))


def check_desktop(tcc_status):
    wait_for_shipit()

    if not os.path.exists(APP_LS):
        log("desktop: %s not present; skip" % APP_LS)
        return

    output = run_patcher(APP_LS, "--dry-run")
    if output is None:
        log("desktop: dry run failed; left untouched")
        return

    if "all gates already unlocked" in output:
        if stamp_is_stale(DESKTOP_STAMP, APP_LS):
            refresh_stamp(DESKTOP_STAMP, APP_LS)
        else:
            log("desktop: already unlocked; stamp current")
        log("desktop: nothing to do; no signal sent")
        return

    if "dry run complete:" not in output:
        log("desktop: unrecognised dry-run result; left untouched")
        return

    if tcc_status == "eperm":
        log("desktop: fresh unpatched binary detected but this host has no "
            "write access (App Management EPERM); skipping in-place patch")
        return

    log("desktop: fresh unpatched binary detected; patching in place")
    result = run_patcher(APP_LS, "--in-place", "--no-backup")
    if result is None:
        log("desktop: patch FAILED; stamp left stale; no signal sent")
        return
    refresh_stamp(DESKTOP_STAMP, APP_LS)
    log("desktop: patched; starting hot reload")
    hot_reload()


def main():
    ap = argparse.ArgumentParser(description="Antigravity context-unlock autopatcher")
    ap.add_argument("--check-tcc", action="store_true",
                    help="only probe kernel write access to the app binary")
    args = ap.parse_args()

    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
    except OSError as exc:
        sys.exit("error: cannot create %s: %s" % (CACHE_DIR, exc))

    lock_fd = acquire_lock()
    if lock_fd is None:
        if args.check_tcc:
            print("TCC_BUSY: another autopatch run holds the lock")
            return 2
        log("busy: another autopatch run holds the lock; exiting")
        return 0

    try:
        if args.check_tcc:
            status, detail = probe_write_access(APP_LS)
            if status == "ok":
                log("check-tcc: TCC_OK")
                print("TCC_OK")
                return 0
            if status == "eperm":
                log("check-tcc: TCC_EPERM: %s" % detail)
                print("TCC_EPERM: %s" % detail)
                return 1
            log("check-tcc: TCC_ERROR: %s" % detail)
            print("TCC_ERROR: %s" % detail)
            return 1

        log("autopatch start (python=%s pid=%d)" % (sys.executable, os.getpid()))

        status, detail = probe_write_access(APP_LS)
        if status == "ok":
            log("tcc_write_access=ok")
        else:
            log("tcc_write_access=%s (%s)" % (status, detail))

        check_cli()
        check_desktop(status)
        log("autopatch done")
        return 0
    finally:
        try:
            os.close(lock_fd)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
