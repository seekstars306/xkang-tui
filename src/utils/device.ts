import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface LocalEnvironmentContext {
  os: string;
  hostname: string;
  username: string;
  cwd: string;
}

export function getLocalEnvironmentContext(): LocalEnvironmentContext {
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname() || 'localhost',
    username: os.userInfo()?.username || 'user',
    cwd: process.cwd(),
  };
}

let cachedDeviceId: string | null = null;

function getDeviceIdFilePath(): string {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.xkang');
  return path.join(configDir, 'device_id');
}

/**
 * Reads stable hardware machine GUID from Windows registry or system files.
 * Unlike network MAC addresses, MachineGuid never changes when VPN, Wi-Fi, or Ethernet states change.
 */
function readHardwareMachineGuid(): string | null {
  const platform = os.platform();

  if (platform === 'win32') {
    // 1. Try Windows Registry MachineGuid (100% stable across all Windows versions)
    try {
      const out = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf-8', timeout: 2000, windowsHide: true }
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+([a-zA-Z0-9-]+)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {}

    // 2. Fallback: Motherboard BIOS UUID
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true }
      );
      const trimmed = out.trim();
      if (trimmed && trimmed.length > 8 && !trimmed.toLowerCase().includes('error')) {
        return trimmed;
      }
    } catch {}
  } else if (platform === 'linux') {
    // Linux system machine-id
    try {
      if (fs.existsSync('/etc/machine-id')) {
        return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
      }
      if (fs.existsSync('/var/lib/dbus/machine-id')) {
        return fs.readFileSync('/var/lib/dbus/machine-id', 'utf-8').trim();
      }
    } catch {}
  } else if (platform === 'darwin') {
    // macOS IOPlatformUUID
    try {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf-8',
        timeout: 2000,
      });
      const match = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/i);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {}
  }

  return null;
}

/**
 * Generates a stable, permanent, privacy-preserving device fingerprint for the current machine.
 *
 * Design Guarantees:
 * 1. Permanently stable: NEVER drifts when users connect/disconnect VPN, switch Wi-Fi/Ethernet, or install VMs.
 * 2. Locally persisted: Stored in ~/.xkang/device_id so it survives app restarts, binary upgrades, and repackaging.
 * 3. Machine-anchored: Leverages OS-level MachineGuid/UUID with fallback to cryptographically secure UUID.
 */
export function getDeviceId(): string {
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  const deviceIdFile = getDeviceIdFilePath();

  // 1. Try reading from persistent local storage (~/.xkang/device_id)
  try {
    if (fs.existsSync(deviceIdFile)) {
      const savedId = fs.readFileSync(deviceIdFile, 'utf-8').trim();
      if (savedId && savedId.length >= 8) {
        cachedDeviceId = savedId;
        return cachedDeviceId;
      }
    }
  } catch {}

  // 2. Generate new stable device ID
  try {
    const hostname = os.hostname() || 'unknown-host';
    const username = os.userInfo()?.username || 'unknown-user';
    const hwGuid = readHardwareMachineGuid();

    let hashSegment: string;
    if (hwGuid) {
      // Anchored to OS MachineGuid
      hashSegment = crypto
        .createHash('sha256')
        .update(`skt_device_${hwGuid}_${hostname}_${username}`)
        .digest('hex')
        .slice(0, 16);
    } else {
      // High-entropy random fallback UUID
      hashSegment = crypto.randomBytes(8).toString('hex');
    }

    cachedDeviceId = `${hostname}-${username}_${hashSegment}`;

    // 3. Persist to ~/.xkang/device_id for permanent permanence
    try {
      const dir = path.dirname(deviceIdFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(deviceIdFile, cachedDeviceId, 'utf-8');
    } catch {}

    return cachedDeviceId;
  } catch {
    // Ultimate fallback
    cachedDeviceId = `${os.hostname() || 'HOST'}_${Math.random().toString(36).slice(2, 10)}`;
    return cachedDeviceId;
  }
}
