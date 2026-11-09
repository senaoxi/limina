import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

interface DiskInfo {
  MountPoint?: string;
  WritableVolume?: boolean;
  WritableMedia?: boolean;
  FilesystemType?: string;
}

function diskInfo(mount: string): DiskInfo {
  const plist = execFileSync('/usr/sbin/diskutil', ['info', '-plist', mount], {
    timeout: 15_000,
  });
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
      input: plist,
      encoding: 'utf8',
      timeout: 15_000,
    }),
  ) as DiskInfo;
}

/**
macOS workspace authority is revoked by detaching its private filesystem.
Renaming directories and setting immutable flags do not revoke open write FDs.
The disk image and frozen mount must remain outside every Agent access root.
*/
export class WorkspaceVolume {
  #mounted: string | null = null;
  readonly #writableMount: string;
  readonly #frozenMount: string;
  readonly root: string;
  readonly workspace: string;
  readonly frozen: string;
  readonly image: string;

  constructor(root: string) {
    if (process.platform !== 'darwin')
      throw new Error('Workspace-volume admission currently covers macOS only');
    mkdirSync(root, { mode: 0o700 });
    this.root = realpathSync(root);
    this.#writableMount = path.join(this.root, 'workspace');
    this.#frozenMount = path.join(this.root, 'frozen');
    // macOS owns volume-root metadata such as .fseventsd. Keep the complete
    // task capture below it instead of excluding an Agent-writable pathname.
    this.workspace = path.join(this.#writableMount, 'project');
    this.frozen = path.join(this.#frozenMount, 'project');
    this.image = path.join(this.root, 'workspace.sparsebundle');
    mkdirSync(this.#writableMount);
    mkdirSync(this.#frozenMount);
  }

  create(): void {
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'create',
        '-size',
        '2g',
        '-type',
        'SPARSEBUNDLE',
        '-fs',
        'APFS',
        '-volname',
        'LiminaEval',
        this.image,
      ],
      { timeout: 60_000, stdio: 'pipe' },
    );
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        this.image,
        '-mountpoint',
        this.#writableMount,
        '-nobrowse',
        '-noautoopen',
      ],
      { timeout: 30_000, stdio: 'pipe' },
    );
    this.#mounted = this.#writableMount;
    const info = diskInfo(this.#writableMount);
    if (info.MountPoint !== this.#writableMount || info.WritableVolume !== true)
      throw new Error('Writable workspace mount not established');
    mkdirSync(this.workspace, { mode: 0o700 });
  }

  freeze(): { root: string; readOnly: true } {
    if (this.#mounted !== this.#writableMount)
      throw new Error('Workspace is not mounted for execution');
    // A failed detach never falls back to a live directory capture.
    execFileSync(
      '/usr/bin/hdiutil',
      ['detach', this.#writableMount, '-force'],
      {
        timeout: 30_000,
        stdio: 'pipe',
      },
    );
    this.#mounted = null;
    execFileSync(
      '/usr/bin/hdiutil',
      [
        'attach',
        this.image,
        '-readonly',
        '-mountpoint',
        this.#frozenMount,
        '-nobrowse',
        '-noautoopen',
      ],
      { timeout: 30_000, stdio: 'pipe' },
    );
    this.#mounted = this.#frozenMount;
    const info = diskInfo(this.#frozenMount);
    if (
      info.MountPoint !== this.#frozenMount ||
      info.WritableVolume !== false ||
      info.WritableMedia !== false
    )
      throw new Error('Read-only final filesystem not established');
    return { root: this.frozen, readOnly: true };
  }

  detach(): void {
    if (!this.#mounted) return;
    execFileSync('/usr/bin/hdiutil', ['detach', this.#mounted, '-force'], {
      timeout: 30_000,
      stdio: 'pipe',
    });
    this.#mounted = null;
  }
}
