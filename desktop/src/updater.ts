import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

const INITIAL_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'downloading'; version: string; percent: number }
    | { status: 'downloaded'; version: string }
    | { status: 'up-to-date' }
    | { status: 'error'; error: string };

interface UpdaterHooks {
    /** Called on every state change so the host can refresh its tray menu. */
    onStateChange: () => void;
    /**
     * Called right before quitAndInstall. The main window hides to the tray on
     * close, so the host must flag a real quit here or the installer never runs.
     */
    beforeInstall: () => void;
}

// The update state lives here rather than in a notification so a downloaded
// update stays visible in the tray menu until it is installed, instead of being
// lost with the toast that announced it.
let state: UpdateState = { status: 'idle' };
let hooks: UpdaterHooks | null = null;
let manualCheckInFlight = false;
let checkInFlight = false;
let listenersRegistered = false;
let initialCheckTimer: NodeJS.Timeout | null = null;
let periodicCheckTimer: NodeJS.Timeout | null = null;

function setState(next: UpdateState): void {
    state = next;
    hooks?.onStateChange();
}

export function getUpdateState(): UpdateState {
    return state;
}

function showNotification(title: string, body: string, onClick?: () => void): void {
    if (!Notification.isSupported()) { return; }
    const notification = new Notification({ title, body });
    if (onClick) { notification.on('click', onClick); }
    notification.show();
}

function reportFailure(error: unknown): void {
    console.warn('[updates] update check failed:', error);
    if (state.status !== 'downloaded') {
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
    if (manualCheckInFlight) {
        showNotification('Update check failed', 'Could not reach GitHub Releases. Try again later.');
    }
    manualCheckInFlight = false;
}

function registerListeners(): void {
    if (listenersRegistered) { return; }
    listenersRegistered = true;

    autoUpdater.on('checking-for-update', () => {
        // A downloaded update outranks a fresh check: keep the install item up so
        // the periodic check never hides a ready update behind "Checking…".
        if (state.status !== 'downloaded') { setState({ status: 'checking' }); }
    });

    autoUpdater.on('update-available', (info) => {
        if (state.status === 'downloaded') { return; }
        setState({ status: 'downloading', version: info.version, percent: 0 });
    });

    autoUpdater.on('download-progress', (progress) => {
        if (state.status !== 'downloading') { return; }
        const percent = Math.round(progress.percent ?? 0);
        if (percent !== state.percent) { setState({ ...state, percent }); }
    });

    autoUpdater.on('update-not-available', () => {
        if (state.status !== 'downloaded') { setState({ status: 'up-to-date' }); }
        if (manualCheckInFlight) {
            showNotification('AI Engineering Fluency is up to date', `Version ${app.getVersion()} is the latest release.`);
        }
        manualCheckInFlight = false;
    });

    autoUpdater.on('update-downloaded', (info) => {
        manualCheckInFlight = false;
        setState({ status: 'downloaded', version: info.version });
        showNotification(
            `AI Engineering Fluency ${info.version} is ready to install`,
            'Click to restart and finish installing.',
            () => installUpdate(),
        );
    });

    autoUpdater.on('error', reportFailure);
}

export function installUpdate(): void {
    if (state.status !== 'downloaded') { return; }
    hooks?.beforeInstall();
    autoUpdater.quitAndInstall();
}

export async function checkForUpdates(manual = false): Promise<void> {
    if (!app.isPackaged) {
        if (manual) {
            showNotification('AI Engineering Fluency updates', 'Update checks are only available in the installed app.');
        }
        return;
    }

    // An update that is downloaded and waiting to be installed is final until the
    // restart. Checking again could restart a download, and if that one failed the
    // tray would lose its "Restart to install" item for an update that is ready.
    if (state.status === 'downloaded') { return; }

    // One check at a time. The periodic timer can fire during a manual check, and
    // a check that found an update is still downloading it; a second
    // checkForUpdates() on top of either duplicates events and flaps the state.
    if (checkInFlight || state.status === 'checking' || state.status === 'downloading') { return; }
    checkInFlight = true;

    registerListeners();
    if (manual) { manualCheckInFlight = true; }

    try {
        const result = await autoUpdater.checkForUpdates();
        // The automatic download is a separate promise. Await it so a failed
        // download reaches this catch instead of being an unhandled rejection,
        // and so the in-flight flag covers the download as well as the check.
        await result?.downloadPromise;
    } catch (error) {
        // electron-updater usually reports failures via the 'error' event, but some
        // (e.g. a missing publish config) only reject this promise — surface those
        // too instead of leaving the tray stuck on "Checking…".
        reportFailure(error);
    } finally {
        checkInFlight = false;
    }
}

/** Checks shortly after launch and then every six hours. No-op in dev (unpackaged) runs. */
export function startUpdateChecks(updaterHooks: UpdaterHooks): void {
    hooks = updaterHooks;
    if (!app.isPackaged || initialCheckTimer || periodicCheckTimer) { return; }

    initialCheckTimer = setTimeout(() => {
        initialCheckTimer = null;
        void checkForUpdates();
    }, INITIAL_CHECK_DELAY_MS);
    initialCheckTimer.unref();

    periodicCheckTimer = setInterval(() => { void checkForUpdates(); }, CHECK_INTERVAL_MS);
    periodicCheckTimer.unref();
}
