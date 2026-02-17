import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import {
  runStatusJson,
  parseStatusJson,
  extractDigest,
  deriveVariantName,
  inferVariantAndChannelFromOrigin
} from './rpm_ostree.js';
import { buildFacts, computeUiState } from './app_state.js';
import { CommandRunner } from './command_runner.js';
import { SettingsWindow } from './settings_window.js';
import { readOsRelease, pickLogoCandidates, firstExistingPath, requestRebootInteractive, isAuthorizationError, runCommandCapture } from './util.js';

export const MainWindow = GObject.registerClass(
  class MainWindow extends Adw.ApplicationWindow {
    constructor(app) {
      super({
        application: app,
        title: app.i18n.t('app_name'),
        default_width: 580,
        default_height: 500
      });

      this._app = app;
      this._facts = null;
      this._check = {
        phase: 'idle',
        downloadSize: null,
        message: ''
      };

      // Automatic updates toggle state (driven by systemd timer).
      this._autoUpdates = {
        enabled: null,
        available: true,
        busy: false
      };
      this._autoUpdatesGuard = false;

      // Track whether the promote menu item is currently shown.
      this._promoteShown = false;
      this._scrollPending = false;

      this._initUi();
      this._refreshStatus().then(() => {
        // Best-effort update check without auth prompts.
        this._checkForUpdates({ interactive: false }).catch((e) => {
          // Print full details to console for diagnostics.
          logError(e, 'Startup update check failed');
          // Never let startup checks crash the UI.
          const msg = e?.message ? e.message : String(e);
          this._check = { phase: 'error', downloadSize: null, message: msg };
          this._applyUiState();
        });
      });
    }

    _initUi() {
      const i18n = this._app.i18n;

      const header = new Adw.HeaderBar();

      // Menu — use sections for safe dynamic updates (Issue 4).
      // The promote section is separate so that insert/remove
      // never shifts the indices of Settings and About.
      this._promoteSection = new Gio.Menu();
      const mainSection = new Gio.Menu();
      mainSection.append(i18n.t('menu_settings'), 'app.open-settings');
      mainSection.append(i18n.t('menu_about'), 'app.about');

      this._menu = new Gio.Menu();
      this._menu.append_section(null, this._promoteSection);
      this._menu.append_section(null, mainSection);

      const menuButton = new Gtk.MenuButton({
        icon_name: 'open-menu-symbolic',
        menu_model: this._menu
      });
      header.pack_end(menuButton);

      // App actions
      const actionSettings = new Gio.SimpleAction({ name: 'open-settings' });
      actionSettings.connect('activate', () => this._openSettings());
      this._app.add_action(actionSettings);

      const actionAbout = new Gio.SimpleAction({ name: 'about' });
      actionAbout.connect('activate', () => this._showAbout());
      this._app.add_action(actionAbout);

      // Issue 4: promote action (initially disabled; enabled dynamically).
      const actionPromote = new Gio.SimpleAction({ name: 'promote-to-stable' });
      actionPromote.connect('activate', () => this._onPromoteClicked());
      this._app.add_action(actionPromote);

      // Main content stack: normal view vs busy view.
      this._stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE
      });

      this._stack.add_named(this._buildMainView(), 'main');
      this._stack.add_named(this._buildBusyView(), 'busy');

      const toolbarView = new Adw.ToolbarView();
      toolbarView.add_top_bar(header);
      toolbarView.set_content(this._stack);
      this.set_content(toolbarView);
    }

    _buildMainView() {
      const i18n = this._app.i18n;

      const clamp = new Adw.Clamp({ maximum_size: 720, tightening_threshold: 560 });
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 16,
        margin_top: 20,
        margin_bottom: 20,
        margin_start: 20,
        margin_end: 20,
        halign: Gtk.Align.FILL
      });

      // Centered header content: logo -> distro name -> "<channel>, <build time>".
      // Keep overall header centered, but control spacing per-widget.
      // We want a larger gap between logo and name, and almost no gap
      // between name and the meta line.
      const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
        halign: Gtk.Align.CENTER
      });

      const logoPath = firstExistingPath(pickLogoCandidates());
      this._logoImage = new Gtk.Image({
        halign: Gtk.Align.CENTER,
        margin_bottom: 18
      });
      this._logoImage.pixel_size = 124;
      if (logoPath)
        this._logoImage.set_from_file(logoPath);
      else
        this._logoImage.set_from_icon_name('computer-symbolic');
      headerBox.append(this._logoImage);

      this._distroNameLabel = new Gtk.Label({
        halign: Gtk.Align.CENTER,
        selectable: false,
        css_classes: ['title-1']
      });
      headerBox.append(this._distroNameLabel);

      this._metaLabel = new Gtk.Label({
        halign: Gtk.Align.CENTER,
        margin_top: 0,
        wrap: true,
        selectable: true,
        css_classes: ['caption', 'dim-label']
      });
      headerBox.append(this._metaLabel);

      box.append(headerBox);

      // Primary action area (centered): Check/Update button OR spinner while checking.
      // Requirement: while checking for updates, replace the button with a spinner.
      this._primaryStack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
        halign: Gtk.Align.CENTER,
        margin_top: 12
      });

      this._primaryButton = new Gtk.Button({
        halign: Gtk.Align.CENTER,
        width_request: 320
      });
      this._primaryButton.add_css_class('suggested-action');
      this._primaryButton.add_css_class('pill');
      this._primaryButton.connect('clicked', () => this._onPrimaryAction());
      this._primaryStack.add_named(this._primaryButton, 'button');

      this._primarySpinner = new Gtk.Spinner({ halign: Gtk.Align.CENTER });
      this._primaryStack.add_named(this._primarySpinner, 'spinner');
      this._primaryStack.set_visible_child_name('button');

      box.append(this._primaryStack);

      // Status line (below the button).
      this._statusLabel = new Gtk.Label({
        halign: Gtk.Align.CENTER,
        wrap: true,
        selectable: true
      });
      box.append(this._statusLabel);

      // Update/Reboot + Rollback block (table-like)
      this._statusGroup = new Adw.PreferencesGroup();

      this._updateReadyRow = new Adw.ActionRow({
        title: i18n.t('reboot_to_apply_update'),
        subtitle: ''
      });
      this._updateReadyRow.set_activatable(false);

      this._rebootButton = new Gtk.Button({
        label: i18n.t('primary_reboot'),
        valign: Gtk.Align.CENTER
      });
      this._rebootButton.add_css_class('suggested-action');
      this._rebootButton.connect('clicked', () => this._doReboot());

      this._updateReadyRow.add_suffix(this._rebootButton);
      this._updateReadyRow.visible = false;
      this._statusGroup.add(this._updateReadyRow);

      this._rollbackRow = new Adw.ActionRow({
        title: i18n.t('rollback_to_previous'),
        subtitle: i18n.t('not_available')
      });
      this._rollbackRow.set_activatable(false);

      this._rollbackButton = new Gtk.Button({
        label: i18n.t('rollback'),
        valign: Gtk.Align.CENTER
      });
      this._rollbackButton.connect('clicked', async () => {
        const ok = await this._confirmRollback();
        if (ok)
          await this._doRollback();
      });
      this._rollbackRow.add_suffix(this._rollbackButton);

      this._statusGroup.add(this._rollbackRow);
      box.append(this._statusGroup);

      // Automatic updates toggle (systemd timer) placed at the bottom of the main page.
      // We intentionally keep it out of Settings as requested.
      this._autoUpdatesGroup = new Adw.PreferencesGroup();
      this._autoUpdatesRow = new Adw.SwitchRow({
        title: i18n.t('auto_updates_title'),
        subtitle: i18n.t('auto_updates_subtitle')
      });
      this._autoUpdatesRow.connect('notify::active', () => this._onAutoUpdatesToggled());
      this._autoUpdatesGroup.add(this._autoUpdatesRow);
      box.append(this._autoUpdatesGroup);

      clamp.set_child(box);
      return clamp;
    }

    _buildBusyView() {
      const i18n = this._app.i18n;
      const clamp = new Adw.Clamp({ maximum_size: 720, tightening_threshold: 560 });

      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 16,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16
      });

      this._busyTitle = new Gtk.Label({
        xalign: 0,
        label: i18n.t('running'),
        css_classes: ['title-3']
      });
      box.append(this._busyTitle);

      this._progress = new Gtk.ProgressBar({ show_text: false });
      this._progress.set_pulse_step(0.05);
      box.append(this._progress);

      const frame = new Gtk.Frame();
      frame.set_margin_top(8);

      const scroller = new Gtk.ScrolledWindow({
        hexpand: true,
        vexpand: true
      });
      this._scroller = scroller;
      this._textBuffer = new Gtk.TextBuffer();
      const textView = new Gtk.TextView({
        buffer: this._textBuffer,
        editable: false,
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR
      });
      this._textView = textView;
      scroller.set_child(textView);
      frame.set_child(scroller);
      box.append(frame);

      // Close button (enabled once the command completes)
      this._busyClose = new Gtk.Button({ label: i18n.t('close'), sensitive: false });
      this._busyClose.connect('clicked', () => {
        this._stack.set_visible_child_name('main');
      });
      box.append(this._busyClose);

      clamp.set_child(box);
      return clamp;
    }

    async _refreshStatus() {
      const i18n = this._app.i18n;
      const osr = readOsRelease();

      const res = await runStatusJson();
      if (!res.ok) {
        this._facts = null;
        this._check = { phase: 'error', downloadSize: null, message: res.error };
        this._statusLabel.set_label(`${i18n.t('error')}: ${res.error}`);
        this._applyUiState();
        return;
      }

      const parsed = parseStatusJson(res.json);
      this._facts = buildFacts({ i18n, osRelease: osr, parsed });
      this._parsed = parsed;

      // Header
      this._distroNameLabel.set_label(this._facts.distroName);
      this._metaLabel.set_label(`${this._facts.channel}, ${this._facts.buildTime}`);

      // Update-ready row (staged/pending)
      if (this._facts.needsReboot) {
        this._updateReadyRow.set_subtitle(this._facts.nextTime);
        this._updateReadyRow.visible = true;
      } else {
        this._updateReadyRow.visible = false;
        this._updateReadyRow.set_subtitle('');
      }

      // Rollback info
      this._rollbackRow.set_subtitle(this._facts.rollbackTime);
      this._rollbackButton.set_sensitive(this._facts.hasRollback);

      this._applyUiState();

      // Update auto-updates toggle in the background.
      this._refreshAutoUpdates().catch((e) => {
        logError(e, 'Failed to refresh automatic updates state');
      });
    }

    _setAutoUpdatesActive(value) {
      this._autoUpdatesGuard = true;
      try {
        this._autoUpdatesRow.set_active(Boolean(value));
      } finally {
        this._autoUpdatesGuard = false;
      }
    }

    async _refreshAutoUpdates() {
      if (!this._autoUpdatesRow)
        return;

      // `rpm-ostreed-automatic.timer` is the standard trigger for automatic rpm-ostree updates.
      const unit = 'rpm-ostreed-automatic.timer';

      const res = await runCommandCapture(['systemctl', 'is-enabled', unit]);
      const out = (res.stdout ?? '').trim();
      const err = (res.stderr ?? '').trim();

      // Important: `systemctl is-enabled` returns a non-zero exit status for some valid
      // states (e.g. "disabled" commonly exits with 1). Treat known states as valid.
      const state = out.toLowerCase();
      const known = new Set([
        'enabled',
        'enabled-runtime',
        'disabled',
        'static',
        'indirect',
        'generated',
        'transient',
        'masked',
      ]);

      if (!known.has(state)) {
        // If the unit doesn't exist or systemctl isn't available, disable the toggle.
        const msg = `${out}\n${err}`.trim().toLowerCase();
        this._autoUpdates.available = false;
        this._autoUpdatesRow.set_sensitive(false);
        if (msg.includes('not found') || msg.includes('no such file') || msg.includes('could not be found'))
          this._autoUpdatesRow.set_subtitle(this._app.i18n.t('auto_updates_unavailable'));
        return;
      }

      this._autoUpdates.available = true;
      this._autoUpdatesRow.set_sensitive(!this._autoUpdates.busy);

      const enabled = state === 'enabled' || state === 'enabled-runtime';
      this._autoUpdates.enabled = enabled;
      this._setAutoUpdatesActive(enabled);
    }

    async _onAutoUpdatesToggled() {
      if (!this._autoUpdatesRow || this._autoUpdatesGuard)
        return;

      const desired = this._autoUpdatesRow.get_active();
      await this._setAutoUpdatesEnabled(desired);
    }

    async _setAutoUpdatesEnabled(enabled) {
      const i18n = this._app.i18n;
      const unit = 'rpm-ostreed-automatic.timer';
      const previous = this._autoUpdates.enabled;

      this._autoUpdates.busy = true;
      this._autoUpdatesRow.set_sensitive(false);

      const argv = enabled
        ? ['systemctl', 'enable', '--now', unit]
        : ['systemctl', 'disable', '--now', unit];

      let res;
      try {
        res = await runCommandCapture(argv);
      } catch (e) {
        logError(e, 'systemctl command failed');
        res = { success: false, stdout: '', stderr: e?.message ? e.message : String(e) };
      }

      this._autoUpdates.busy = false;

      if (!res.success) {
        // Revert the UI state and show a concise error.
        this._autoUpdates.enabled = previous;
        this._setAutoUpdatesActive(previous);
        this._autoUpdatesRow.set_sensitive(true);

        const msg = `${(res.stdout ?? '').trim()}\n${(res.stderr ?? '').trim()}`.trim();
        const base = enabled ? i18n.t('auto_updates_error_enable') : i18n.t('auto_updates_error_disable');
        this._showInfo(msg ? `${base}\n\n${msg}` : base);
        await this._refreshAutoUpdates();
        return;
      }

      // Success: reflect current state.
      this._autoUpdatesRow.set_sensitive(true);
      await this._refreshAutoUpdates();
    }

    _applyUiState() {
      const i18n = this._app.i18n;
      if (!this._facts) {
        this._primaryMode = 'check';
        this._primaryButton.set_label(i18n.t('primary_check'));
        return;
      }

      const ui = computeUiState({ i18n, facts: this._facts, check: this._check });
      this._primaryMode = ui.primaryMode;
      this._primaryButton.set_label(ui.primaryLabel);

      if (ui.showCheckSpinner) {
        this._primaryButton.set_sensitive(false);
        this._primarySpinner.start();
        this._primaryStack.set_visible_child_name('spinner');
      } else {
        this._primaryButton.set_sensitive(true);
        this._primarySpinner.stop();
        this._primaryStack.set_visible_child_name('button');
      }

      this._statusLabel.set_label(ui.statusText || '');

      // Issue 4: dynamically add/remove "Promote to stable" menu item.
      this._updatePromoteMenuItem();
    }

    // Issue 4: show "Promote to stable" only when channel=latest and variant=standard|nvidia.
    _updatePromoteMenuItem() {
      const i18n = this._app.i18n;

      const origin = this._facts?.currentOrigin || '';
      const inf = inferVariantAndChannelFromOrigin(origin);
      const shouldShow = inf.channel === 'latest' && (inf.variant === 'standard' || inf.variant === 'nvidia');

      if (shouldShow && !this._promoteShown) {
        this._promoteSection.append(i18n.t('promote_to_stable'), 'app.promote-to-stable');
        this._promoteShown = true;
      } else if (!shouldShow && this._promoteShown) {
        this._promoteSection.remove(0);
        this._promoteShown = false;
      }
    }

    async _onPrimaryAction() {
      if (this._primaryMode === 'check')
        return this._checkForUpdates({ interactive: true });
      if (this._primaryMode === 'update')
        return this._doUpgrade();
    }

    async _checkForUpdates({ interactive }) {
      const i18n = this._app.i18n;

      // Refresh status first so we do not misreport download sizes when an update
      // has already been staged by automatic updates.
      await this._refreshStatus();

      this._check = { phase: 'checking', downloadSize: null, message: '' };
      this._applyUiState();

      let output = '';
      const runner = new CommandRunner({
        onStdout: (t) => { output += t; },
        onStderr: (t) => { output += t; }
      });

      let success = false;
      try {
        // `rpm-ostree update --check` works unprivileged; never prompt for auth here.
        ({ success } = await runner.run(['rpm-ostree', 'update', '--check'], { root: false }));
      } catch (e) {
        logError(e, 'rpm-ostree update --check failed');
        success = false;
        output += `\n${e?.message ? e.message : String(e)}`;
      }

      // Filter informational notes; they are not actionable for end users.
      const filteredOutput = output
        .split(/\r?\n/)
        .map(l => l.replace(/\u00a0/g, ' ')) // normalize non-breaking spaces
        .filter((l) => {
          const t = l.trim();
          if (!t) return false;
          if (/^note\s*:/i.test(t)) return false;
          return true;
        })
        .join('\n');

      const hasAvailableUpdate = /\bAvailableUpdate\s*:/i.test(filteredOutput);
      const hasNoUpdates = /\bNo updates available\b/i.test(filteredOutput) && !hasAvailableUpdate;

      // Prefer Added layers size; Total layers often overstates the real download.
      let size = null;
      const addedSizeMatch = filteredOutput.match(/AvailableUpdate:[\s\S]*?\n\s*Added layers\s*:[\s\S]*?\n\s*Size\s*:\s*([^\n]+)/i);
      if (addedSizeMatch)
        size = addedSizeMatch[1].trim();
      if (!size) {
        const anySizeMatch = filteredOutput.match(/AvailableUpdate:[\s\S]*?\n\s*Size\s*:\s*([^\n]+)/i);
        if (anySizeMatch)
          size = anySizeMatch[1].trim();
      }

      if (!success) {
        // Some rpm-ostree versions can exit non-zero while still printing a definitive result.
        if (hasNoUpdates) {
          this._check = { phase: 'no_updates', downloadSize: null, message: '' };
        } else {
          this._check = {
            phase: 'error',
            downloadSize: null,
            message: filteredOutput.trim() || 'rpm-ostree update --check failed'
          };
        }
        this._applyUiState();
        return;
      }

      // Issue 5: do NOT suppress available updates when staged update exists.
      // rpm-ostree update --check compares against the booted deployment, so if it
      // says AvailableUpdate, there is genuinely a newer image vs what's currently running.
      if (hasAvailableUpdate) {
        this._check = { phase: 'available', downloadSize: size, message: '' };
      } else {
        this._check = { phase: 'no_updates', downloadSize: null, message: '' };
      }

      // Update UI and refresh status again in case staging changed while checking.
      this._applyUiState();
      await this._refreshStatus();
    }

    _enterBusy(title) {
      const i18n = this._app.i18n;
      this._busyTitle.set_label(title || i18n.t('running'));
      this._busyClose.set_sensitive(false);
      this._textBuffer.set_text('', -1);
      this._stack.set_visible_child_name('busy');
      this._determinateProgress = false;

      // Pulse animation.
      this._progress.set_fraction(0);
      if (this._pulseId) {
        GLib.source_remove(this._pulseId);
        this._pulseId = null;
      }
      this._pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
        if (!this._determinateProgress)
          this._progress.pulse();
        return GLib.SOURCE_CONTINUE;
      });
    }

    _leaveBusy() {
      if (this._pulseId) {
        GLib.source_remove(this._pulseId);
        this._pulseId = null;
      }
      this._progress.set_fraction(1.0);
      this._determinateProgress = false;
      this._busyClose.set_sensitive(true);
    }

    // Issue 3: handle \r (carriage return) for in-place progress updates.
    // Also parses chunk progress from rpm-ostree output for the progress bar.
    _appendOutput(text) {
      // Split input on \r and \n to simulate terminal carriage-return behavior.
      // \r without \n means "overwrite the current line from the beginning".
      const parts = text.split(/(\r\n|\r|\n)/);

      for (const part of parts) {
        if (part === '\n' || part === '\r\n') {
          // Real newline: insert at end.
          const endIter = this._textBuffer.get_end_iter();
          this._textBuffer.insert(endIter, '\n', -1);
        } else if (part === '\r') {
          // Carriage return: delete from the last \n to the end of the buffer,
          // so the next text will overwrite the current line.
          const endIter = this._textBuffer.get_end_iter();
          const [, lineStart] = this._textBuffer.get_iter_at_line(endIter.get_line());
          if (lineStart.get_offset() < endIter.get_offset()) {
            this._textBuffer.delete(lineStart, endIter);
          }
        } else if (part.length > 0) {
          // Regular text: insert at end.
          const endIter = this._textBuffer.get_end_iter();
          this._textBuffer.insert(endIter, part, -1);
        }
      }

      // Try to parse chunk progress for the progress bar (Issue 3).
      this._tryParseChunkProgress(text);

      // Auto-scroll to the bottom of the text view.
      this._autoScrollToBottom();
    }

    _autoScrollToBottom() {
      // Debounce: only one pending scroll at a time to avoid flooding
      // the GLib main loop when chunks arrive rapidly.
      if (this._scrollPending) return;
      this._scrollPending = true;
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._scrollPending = false;
        if (this._textView && this._scroller) {
          const vadj = this._scroller.get_vadjustment();
          if (vadj)
            vadj.set_value(vadj.get_upper() - vadj.get_page_size());
        }
        return GLib.SOURCE_REMOVE;
      });
    }

    // Issue 3: extract download progress from rpm-ostree output.
    // Patterns like: "Fetching ... 5/20 chunks" or just "N/M" followed by "chunks"|"metadata"|"signatures".
    _tryParseChunkProgress(text) {
      // Require a download-phase keyword before N/M to avoid false positives
      // from unrelated output like "file 1/2 chunks removed".
      const m = text.match(/(?:Fetching|Downloading|Receiving|Pulling)[^\n]*?(\d+)\/(\d+)\s*(?:chunks|metadata|signatures)/i);
      if (m) {
        const current = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        if (total > 0 && current <= total) {
          this._determinateProgress = true;
          this._progress.set_fraction(current / total);
          return;
        }
      }

      // If the line contains "Importing" or "Writing" or "Staging", revert to pulse.
      if (/\b(Importing|Writing|Staging|Checking out)\b/i.test(text)) {
        this._determinateProgress = false;
      }
    }

    async _doUpgrade() {
      const i18n = this._app.i18n;
      // Issue 2: descriptive busy title.
      this._enterBusy(i18n.t('busy_applying_update'));

      let collected = '';

      const runner = new CommandRunner({
        onStdout: (t) => { collected += t; this._appendOutput(t); },
        onStderr: (t) => { collected += t; this._appendOutput(t); }
      });

      // Use `rpm-ostree update` for consistency with `update --check`.
      let result = await runner.run(['rpm-ostree', 'update'], { root: false });
      if (!result.success && isAuthorizationError(collected)) {
        collected = '';
        this._appendOutput('\nAuthorization required; retrying with elevated privileges…\n');
        result = await runner.run(['rpm-ostree', 'update'], { root: true });
      }

      this._leaveBusy();

      if (result.success) {
        // After applying an update, the next boot deployment is typically staged.
        // Do not auto-reboot; just refresh facts and UI.
        this._check = { phase: 'idle', downloadSize: null, message: '' };
        // Do not trigger a reboot prompt automatically after an update.
        // The main UI will indicate that a reboot is required.
      }

      await this._refreshStatus();
    }

    async _doRollback() {
      const i18n = this._app.i18n;
      // Issue 2: descriptive busy title.
      this._enterBusy(i18n.t('busy_rolling_back'));

      let collected = '';

      const runner = new CommandRunner({
        onStdout: (t) => { collected += t; this._appendOutput(t); },
        onStderr: (t) => { collected += t; this._appendOutput(t); }
      });

      let result = await runner.run(['rpm-ostree', 'rollback'], { root: false });
      if (!result.success && isAuthorizationError(collected)) {
        collected = '';
        this._appendOutput('\nAuthorization required; retrying with elevated privileges…\n');
        result = await runner.run(['rpm-ostree', 'rollback'], { root: true });
      }

      this._leaveBusy();

      if (result.success) {
        // A rollback creates a new deployment; the UI will indicate reboot is required.
        this._check = { phase: 'idle', downloadSize: null, message: '' };
        try {
          await requestRebootInteractive();
        } catch (e) {
          logError(e, 'Reboot prompt failed after rollback');
        }
      }

      await this._refreshStatus();
    }

    // Issue 1: rebase is now triggered from MainWindow (delegated from Settings).
    async _doRebase(targetRef) {
      // Guard: if MainWindow was destroyed between signal emission and
      // this call (e.g., user closed the window), bail out safely.
      if (!this._stack) return;
      const i18n = this._app.i18n;
      // Issue 2: descriptive busy title.
      this._enterBusy(i18n.t('busy_rebasing'));

      let collected = '';

      const runner = new CommandRunner({
        onStdout: (t) => { collected += t; this._appendOutput(t); },
        onStderr: (t) => { collected += t; this._appendOutput(t); }
      });

      let result = await runner.run(['rpm-ostree', 'rebase', targetRef], { root: false });
      if (!result.success && isAuthorizationError(collected)) {
        collected = '';
        this._appendOutput('\nAuthorization required; retrying with elevated privileges…\n');
        result = await runner.run(['rpm-ostree', 'rebase', targetRef], { root: true });
      }

      this._leaveBusy();

      if (result.success) {
        this._check = { phase: 'idle', downloadSize: null, message: '' };
        this._showInfo(i18n.t('rebase_complete_reboot_required'));
      }

      await this._refreshStatus();
    }

    async _doReboot() {
      // Reboot should use the desktop environment's native confirmation UI.
      // We intentionally do NOT show the busy/console-output view for this action.
      // NOTE: GNOME's reboot prompt is handled out-of-process (gnome-shell).
      // The D-Bus method may return success even if the user presses Cancel.
      // Therefore, we only "debounce" the button briefly instead of disabling it permanently.
      this._rebootButton?.set_sensitive(false);
      try {
        await requestRebootInteractive();
      } catch (e) {
        logError(e, 'Reboot request failed');
        const msg = e?.message ? e.message : String(e);
        this._showInfo(`${this._app.i18n.t('error')}: ${msg}`);
      } finally {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
          this._rebootButton?.set_sensitive(true);
          return GLib.SOURCE_REMOVE;
        });
      }
    }

    _openSettings() {
      const win = new SettingsWindow({
        transient_for: this,
        application: this._app,
        currentOrigin: this._facts?.currentOrigin || ''
      });
      // Issue 1: Settings now emits 'rebase-requested' instead of running rebase itself.
      win.connect('rebase-requested', (_w, targetRef) => {
        this._doRebase(targetRef);
      });
      win.present();
    }

    // Issue 4: "Promote this image to stable" feature.
    async _onPromoteClicked() {
      const i18n = this._app.i18n;

      // Confirmation dialog.
      const confirmed = await new Promise((resolve) => {
        const dlg = new Adw.MessageDialog({
          transient_for: this,
          modal: true,
          heading: i18n.t('confirm_promote_title'),
          body: i18n.t('confirm_promote_body')
        });
        dlg.add_response('cancel', i18n.t('cancel'));
        dlg.add_response('promote', i18n.t('promote_to_stable'));
        dlg.set_default_response('cancel');
        dlg.set_close_response('cancel');
        dlg.set_response_appearance('promote', Adw.ResponseAppearance.SUGGESTED);
        dlg.connect('response', (_d, resp) => {
          dlg.destroy();
          resolve(resp === 'promote');
        });
        dlg.present();
      });
      if (!confirmed) return;

      // Check if gh CLI is available.
      const ghCheck = await runCommandCapture(['which', 'gh']);
      if (!ghCheck.success) {
        this._showInfo(i18n.t('gh_not_installed'));
        return;
      }

      // Extract variant and digest.
      const booted = this._parsed?.booted;
      const origin = this._facts?.currentOrigin || '';
      const variant = deriveVariantName(origin);
      const digest = extractDigest(booted);

      if (!variant || !digest) {
        this._showInfo(`${i18n.t('promote_error')}\n\nCould not determine variant (${variant}) or digest (${digest}).`);
        return;
      }

      this._enterBusy(i18n.t('busy_promoting'));

      let collected = '';
      const runner = new CommandRunner({
        onStdout: (t) => { collected += t; this._appendOutput(t); },
        onStderr: (t) => { collected += t; this._appendOutput(t); }
      });

      const result = await runner.run([
        'gh', 'workflow', 'run', 'promote-image-to-stable.yml',
        '-R', 'komorebinator/borshevik',
        '-f', `variant=${variant}`,
        '-f', `digest=${digest}`
      ], { root: false });

      this._leaveBusy();

      if (result.success) {
        this._appendOutput(`\n${i18n.t('promote_success')}\n`);
      } else {
        this._appendOutput(`\n${i18n.t('promote_error')}\n`);
      }

      await this._refreshStatus();
    }

    _showAbout() {
      const i18n = this._app.i18n;
      const about = new Adw.AboutWindow({
        transient_for: this,
        application_name: i18n.t('app_name'),
        developer_name: 'Borshevik',
        version: '1.0',
        comments: i18n.t('about_details')
      });
      about.present();
    }

    async _confirmRollback() {
      const i18n = this._app.i18n;
      return await new Promise((resolve) => {
        const dlg = new Adw.MessageDialog({
          transient_for: this,
          modal: true,
          heading: i18n.t('confirm_rollback_title'),
          body: i18n.t('confirm_rollback_body')
        });

        dlg.add_response('cancel', i18n.t('cancel'));
        dlg.add_response('rollback', i18n.t('rollback'));
        dlg.set_default_response('cancel');
        dlg.set_close_response('cancel');
        dlg.set_response_appearance('rollback', Adw.ResponseAppearance.DESTRUCTIVE);

        dlg.connect('response', (_d, resp) => {
          dlg.destroy();
          resolve(resp === 'rollback');
        });

        dlg.present();
      });
    }

    _showInfo(message) {
      const i18n = this._app.i18n;
      const dlg = new Adw.MessageDialog({
        transient_for: this,
        heading: i18n.t('app_name'),
        body: message
      });
      dlg.add_response('ok', i18n.t('ok'));
      dlg.set_default_response('ok');
      dlg.set_close_response('ok');
      dlg.present();
    }
  });
