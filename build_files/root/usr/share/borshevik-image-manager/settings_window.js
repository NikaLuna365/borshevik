import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import {
  buildTargetRef,
  inferVariantAndChannelFromOrigin,
  stripDockerTagIfPresent
} from './rpm_ostree.js';

const DEFAULT_STANDARD = 'ostree-image-signed:docker://ghcr.io/komorebinator/borshevik';
const DEFAULT_NVIDIA = 'ostree-image-signed:docker://ghcr.io/komorebinator/borshevik-nvidia';

export const SettingsWindow = GObject.registerClass(
  {
    Signals: {
      // Issue 1: Settings no longer runs rebase itself.
      // It emits 'rebase-requested' with the target ref and closes.
      // MainWindow handles the rebase in its own busy view.
      'rebase-requested': { param_types: [GObject.TYPE_STRING] }
    }
  },
  class SettingsWindow extends Adw.Window {
    constructor({ application, transient_for, currentOrigin }) {
      super({
        application,
        transient_for,
        title: application.i18n.t('settings_title'),
        default_width: 580,
        default_height: 500
      });

      this._app = application;
      this._initialOrigin = currentOrigin || '';
      this._initial = this._inferInitialState(this._initialOrigin);
      this._current = { ...this._initial };

      this._initUi();
      this._syncUiFromState();
      this._updateDerived();
    }

    _inferInitialState(origin) {
      const inf = inferVariantAndChannelFromOrigin(origin);
      let imageUrl = '';
      if (inf.variant === 'standard') imageUrl = DEFAULT_STANDARD;
      else if (inf.variant === 'nvidia') imageUrl = DEFAULT_NVIDIA;
      else imageUrl = stripDockerTagIfPresent(origin) || '';

      return {
        variant: inf.variant,
        channel: inf.channel,
        customTag: inf.customTag,
        imageUrl
      };
    }

    _initUi() {
      const i18n = this._app.i18n;

      const header = new Adw.HeaderBar();
      const toolbarView = new Adw.ToolbarView();
      toolbarView.add_top_bar(header);

      // Issue 1: no more busy stack — settings is a simple form.
      const content = this._buildSettingsView();
      toolbarView.set_content(content);
      this.set_content(toolbarView);

      // Bottom buttons in header bar.
      this._applyBtn = new Gtk.Button({ label: i18n.t('apply'), sensitive: false });
      this._applyBtn.add_css_class('suggested-action');
      this._applyBtn.connect('clicked', () => this._onApply());

      this._resetBtn = new Gtk.Button({ label: i18n.t('reset') });
      this._resetBtn.connect('clicked', () => this._onReset());

      header.pack_end(this._applyBtn);
      header.pack_end(this._resetBtn);
    }

    _buildSettingsView() {
      const i18n = this._app.i18n;
      const clamp = new Adw.Clamp({ maximum_size: 720, tightening_threshold: 560 });

      const scroller = new Gtk.ScrolledWindow({ vexpand: true });
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 14,
        margin_top: 16,
        margin_bottom: 16,
        margin_start: 16,
        margin_end: 16
      });

      const makeFieldRow = (title, widget) => {
        // A PreferencesRow that puts the label above the control to fit narrow widths.
        const row = new Adw.PreferencesRow();
        const v = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
          margin_top: 10,
          margin_bottom: 10,
          margin_start: 12,
          margin_end: 12
        });

        const lbl = new Gtk.Label({ label: title, xalign: 0 });
        lbl.add_css_class('caption');
        lbl.add_css_class('dim-label');
        v.append(lbl);

        widget.set_hexpand?.(true);
        v.append(widget);
        row.set_child(v);
        return row;
      };

      // Variant (radio)
      const variantGroup = new Adw.PreferencesGroup({ title: i18n.t('variant') });
      this._variantStandardBtn = new Gtk.CheckButton();
      this._variantNvidiaBtn = new Gtk.CheckButton({ group: this._variantStandardBtn });
      this._variantCustomBtn = new Gtk.CheckButton({ group: this._variantStandardBtn });

      const v1 = new Adw.ActionRow({ title: i18n.t('variant_standard') });
      v1.add_prefix(this._variantStandardBtn);
      v1.set_activatable_widget(this._variantStandardBtn);
      variantGroup.add(v1);

      const v2 = new Adw.ActionRow({ title: i18n.t('variant_nvidia') });
      v2.add_prefix(this._variantNvidiaBtn);
      v2.set_activatable_widget(this._variantNvidiaBtn);
      variantGroup.add(v2);

      const v3 = new Adw.ActionRow({ title: i18n.t('variant_custom') });
      v3.add_prefix(this._variantCustomBtn);
      v3.set_activatable_widget(this._variantCustomBtn);
      variantGroup.add(v3);

      box.append(variantGroup);

      // Image URL
      const imageGroup = new Adw.PreferencesGroup();
      this._imageEntry = new Gtk.Entry({ hexpand: true });
      imageGroup.add(makeFieldRow(i18n.t('image_url'), this._imageEntry));
      box.append(imageGroup);

      // Channel (radio)
      const channelGroup = new Adw.PreferencesGroup({ title: i18n.t('channel_choice') });
      this._channelLatestBtn = new Gtk.CheckButton();
      this._channelStableBtn = new Gtk.CheckButton({ group: this._channelLatestBtn });
      this._channelCustomBtn = new Gtk.CheckButton({ group: this._channelLatestBtn });

      const c1 = new Adw.ActionRow({ title: i18n.t('channel_latest') });
      c1.add_prefix(this._channelLatestBtn);
      c1.set_activatable_widget(this._channelLatestBtn);
      channelGroup.add(c1);

      const c2 = new Adw.ActionRow({ title: i18n.t('channel_stable') });
      c2.add_prefix(this._channelStableBtn);
      c2.set_activatable_widget(this._channelStableBtn);
      channelGroup.add(c2);

      const c3 = new Adw.ActionRow({ title: i18n.t('channel_custom') });
      c3.add_prefix(this._channelCustomBtn);
      c3.set_activatable_widget(this._channelCustomBtn);
      channelGroup.add(c3);

      box.append(channelGroup);

      // Custom tag
      const tagGroup = new Adw.PreferencesGroup();
      this._customTagEntry = new Gtk.Entry({ hexpand: true });
      this._tagRow = makeFieldRow(i18n.t('custom_tag'), this._customTagEntry);
      tagGroup.add(this._tagRow);
      box.append(tagGroup);

      // Target ref (preview)
      const previewGroup = new Adw.PreferencesGroup();
      this._targetPreview = new Gtk.Entry({ editable: false, can_focus: false, hexpand: true });
      previewGroup.add(makeFieldRow(i18n.t('target_ref'), this._targetPreview));
      box.append(previewGroup);

      scroller.set_child(box);
      clamp.set_child(scroller);

      // Wire signals
      this._variantStandardBtn.connect('toggled', () => {
        if (!this._variantStandardBtn.get_active()) return;
        this._current.variant = 'standard';
        this._updateDerived();
      });
      this._variantNvidiaBtn.connect('toggled', () => {
        if (!this._variantNvidiaBtn.get_active()) return;
        this._current.variant = 'nvidia';
        this._updateDerived();
      });
      this._variantCustomBtn.connect('toggled', () => {
        if (!this._variantCustomBtn.get_active()) return;
        this._current.variant = 'custom';
        this._updateDerived();
      });

      this._channelLatestBtn.connect('toggled', () => {
        if (!this._channelLatestBtn.get_active()) return;
        this._current.channel = 'latest';
        this._updateDerived();
      });
      this._channelStableBtn.connect('toggled', () => {
        if (!this._channelStableBtn.get_active()) return;
        this._current.channel = 'stable';
        this._updateDerived();
      });
      this._channelCustomBtn.connect('toggled', () => {
        if (!this._channelCustomBtn.get_active()) return;
        this._current.channel = 'custom';
        this._updateDerived();
      });

      this._imageEntry.connect('changed', () => {
        this._current.imageUrl = this._imageEntry.get_text();
        this._updateDerived();
      });

      this._customTagEntry.connect('changed', () => {
        this._current.customTag = this._customTagEntry.get_text();
        this._updateDerived();
      });

      return clamp;
    }

    _syncUiFromState() {
      // Variant
      this._variantStandardBtn.set_active(this._current.variant === 'standard');
      this._variantNvidiaBtn.set_active(this._current.variant === 'nvidia');
      this._variantCustomBtn.set_active(this._current.variant === 'custom');

      // Channel
      this._channelLatestBtn.set_active(this._current.channel === 'latest');
      this._channelStableBtn.set_active(this._current.channel === 'stable');
      this._channelCustomBtn.set_active(this._current.channel === 'custom');

      this._imageEntry.set_text(this._current.imageUrl || '');
      this._customTagEntry.set_text(this._current.customTag || '');
    }

    _updateDerived() {
      const i18n = this._app.i18n;

      // Image URL enabling
      if (this._current.variant === 'standard') {
        this._current.imageUrl = DEFAULT_STANDARD;
        this._imageEntry.set_sensitive(false);
      } else if (this._current.variant === 'nvidia') {
        this._current.imageUrl = DEFAULT_NVIDIA;
        this._imageEntry.set_sensitive(false);
      } else {
        this._imageEntry.set_sensitive(true);
      }

      // Custom tag visibility/enabling
      const isCustomChannel = this._current.channel === 'custom';
      this._customTagEntry.set_sensitive(isCustomChannel);
      this._tagRow.set_visible(isCustomChannel);

      // Compute preview
      const base = (this._current.variant === 'standard') ? DEFAULT_STANDARD
        : (this._current.variant === 'nvidia') ? DEFAULT_NVIDIA
          : (this._current.imageUrl || '');

      const target = buildTargetRef(base, this._current.channel, this._current.customTag);
      this._targetPreview.set_text(target || '');

      const dirty = JSON.stringify(this._current) !== JSON.stringify(this._initial);
      const valid = Boolean(target);
      this._applyBtn.set_sensitive(dirty && valid);

      // If channel isn't custom, keep customTag but it won't be used; that's okay.
      if (!isCustomChannel) {
        this._customTagEntry.set_text(this._current.customTag || '');
      }

      // Update a small hint in window title to show dirty state.
      this.set_title(dirty ? `${i18n.t('settings_title')} *` : i18n.t('settings_title'));
    }

    _onReset() {
      this._current = { ...this._initial };
      this._syncUiFromState();
      this._updateDerived();
    }

    _onApply() {
      const base = (this._current.variant === 'standard') ? DEFAULT_STANDARD
        : (this._current.variant === 'nvidia') ? DEFAULT_NVIDIA
          : (this._current.imageUrl || '');

      const target = buildTargetRef(base, this._current.channel, this._current.customTag);
      if (!target)
        return;

      // Issue 1: emit signal with target ref, then close.
      // MainWindow will handle the rebase in its busy view.
      this.emit('rebase-requested', target);

      // Close settings window after a brief delay to avoid destroying
      // the widget mid-event-handler (Risk 2 mitigation).
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this.close();
        return GLib.SOURCE_REMOVE;
      });
    }
  }
);
