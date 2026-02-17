// Robust i18n with embedded English defaults.
// - English strings are embedded in code as the ultimate fallback.
// - JSON locale files (en.json, ru.json, etc.) are loaded as optional overrides.
// - Fallback chain: locale JSON → en.json → DEFAULT_STRINGS → key itself (with warning).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Canonical English strings. This object is the single source of truth.
// Even if all JSON files are deleted, the app will function correctly.
const DEFAULT_STRINGS = {
  app_name: 'Borshevik Image Manager',
  current_version: 'Current version',
  distribution: 'Distribution',
  channel: 'Channel',
  build_time: 'Build time',
  origin: 'Origin',
  primary_check: 'Check for updates',
  primary_update: 'Update',
  primary_reboot: 'Reboot',
  reboot_to_apply_update: 'Reboot to apply update',
  new_version_available: 'Update is staged and ready to apply:',
  checking_for_updates: 'Checking for updates…',
  update_check_needs_auth: "Click 'Check for updates' to authorize update check.",
  no_updates_available: 'No new updates available.',
  no_new_updates: 'No new updates available.',
  update_pending_reboot: 'Update is ready — reboot to apply.',
  updates_available: 'Updates available.',
  download_size: 'Download size',
  unknown: 'Unknown',
  rollback: 'Rollback',
  cancel: 'Cancel',
  confirm_rollback_title: 'Rollback to previous version?',
  confirm_rollback_body: 'Your system will boot into the previous version after a reboot. Continue?',
  rollback_to_previous: 'Rollback to previous image',
  rollback_target: 'Rollback target',
  not_available: 'Not available',
  menu_settings: 'Settings',
  menu_about: 'About',
  settings_title: 'Settings',
  variant: 'Variant',
  variant_standard: 'Standard',
  variant_nvidia: 'NVIDIA',
  variant_custom: 'Custom',
  image_url: 'Image URL',
  channel_choice: 'Channel',
  channel_latest: 'latest',
  channel_stable: 'stable',
  channel_custom: 'custom',
  custom_tag: 'Custom tag',
  target_ref: 'Target ref',
  apply: 'Apply',
  reset: 'Reset',
  back: 'Back',
  rebase_complete_reboot_required: 'Rebase complete. Reboot required.',
  rollback_complete_reboot_required: 'Rollback complete. Reboot required.',
  upgrade_complete_reboot_required: 'Update complete. Reboot required.',
  auto_updates_title: 'Automatic updates',
  auto_updates_subtitle: 'Download and install updates automatically',
  auto_updates_unavailable: 'Automatic updates are not available on this system',
  auto_updates_error_enable: 'Failed to enable automatic updates.',
  auto_updates_error_disable: 'Failed to disable automatic updates.',
  running: 'Running…',
  command_output: 'Command output',
  error: 'Error',
  ok: 'OK',
  close: 'Close',
  about_details: 'A simple GUI wrapper around rpm-ostree for checking updates, upgrading, rebooting to apply, rolling back, and rebasing images.',

  // Issue 2: descriptive busy-view titles
  busy_applying_update: 'Applying update…',
  busy_rolling_back: 'Rolling back…',
  busy_rebasing: 'Rebasing…',
  busy_promoting: 'Promoting to stable…',

  // Issue 4: promote-to-stable feature
  promote_to_stable: 'Promote this image to stable',
  confirm_promote_title: 'Promote to stable?',
  confirm_promote_body: 'This will tag the current image digest as "stable" in the container registry. Continue?',
  promote_success: 'Promotion workflow triggered successfully.',
  promote_error: 'Failed to trigger promotion workflow.',
  gh_not_installed: 'The GitHub CLI (gh) is not installed. Install it to use this feature.',

  // Issue 5: staged + new update available
  update_pending_newer_available: 'A newer update is available (previous update is pending reboot).',
};

function _readJson(path) {
  try {
    const bytes = GLib.file_get_contents(path)[1];
    const text = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) {
      log(`[i18n] WARNING: Invalid JSON in ${path}: ${e.message}`);
    }
    return null;
  }
}

function _getLocale() {
  const env = GLib.getenv('LANGUAGE') || GLib.getenv('LC_MESSAGES') || GLib.getenv('LANG') || 'en';
  // Examples: en_US.UTF-8, ru_RU.UTF-8
  const m = env.match(/^([a-zA-Z]{2})/);
  return (m ? m[1] : 'en').toLowerCase();
}

export class I18n {
  constructor(baseDir) {
    this._baseDir = baseDir;
    this._en = _readJson(GLib.build_filenamev([baseDir, 'en.json'])) || {};

    const locale = _getLocale();
    if (locale === 'en') {
      this._dict = this._en;
    } else {
      this._dict = _readJson(GLib.build_filenamev([baseDir, `${locale}.json`])) || {};
    }
  }

  t(key) {
    // 1. Current locale JSON
    if (key in this._dict)
      return this._dict[key];
    // 2. English JSON (file override)
    if (key in this._en)
      return this._en[key];
    // 3. Embedded defaults (always available)
    if (key in DEFAULT_STRINGS)
      return DEFAULT_STRINGS[key];
    // 4. Key itself as last resort (with warning for debugging)
    log(`[i18n] WARNING: Missing translation key: "${key}"`);
    return key;
  }
}
