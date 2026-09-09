export const ENGLISH_MESSAGES = {
  toolbar_widget_unavailable: "MeanThis could not start its in-page tool. Click MeanThis again to open the side panel.",
  comparison_check: "Check for changes",
  comparison_copy: "Copy comparison",
  comparison_copied: "Comparison copied",
  comparison_hint: "Compare this target with its saved capture.",
  comparison_checking: "Checking the current target…",
  comparison_unavailable: "Return to this target’s page and recheck it before comparing.",
  comparison_missing: "The target could not be found. Its saved capture is unchanged.",
  comparison_ambiguous: "More than one target matches. Select the intended target again.",
  comparison_changed: "{count} changed fields · {compared} fields compared",
  comparison_unchanged: "No differences in the {compared} fields compared.",
  comparison_times: "Captured: {before} · Checked: {after}",
  comparison_partial: "{count} fields could not be compared because they were missing, redacted, or too long.",
  comparison_boundary: "This is the current matching candidate. Review whether it meets your request. Position is relative to the viewport, rounded to 0.1 CSS pixels.",
  comparison_copy_failed: "Copy failed. Try copying the comparison again.",
  comparison_before: "Before",
  comparison_after: "Now",
  comparison_empty: "Empty",
  comparison_yes: "Yes",
  comparison_no: "No",
  comparison_element_tagName: "Element type",
  comparison_element_role: "Role",
  comparison_element_text: "Text",
  comparison_element_accessibleName: "Accessible name",
  comparison_element_visible: "Visible",
  comparison_element_enabled: "Enabled",
  comparison_element_bbox_x: "Viewport left",
  comparison_element_bbox_y: "Viewport top",
  comparison_element_bbox_width: "Width",
  comparison_element_bbox_height: "Height",
  comparison_style_display: "Display",
  comparison_style_color: "Text color",
  comparison_style_backgroundColor: "Background color",
  comparison_style_fontSize: "Font size",
  comparison_style_fontWeight: "Font weight",
  comparison_style_lineHeight: "Line height",
  comparison_style_margin: "Outer spacing",
  comparison_style_padding: "Inner spacing",
  comparison_style_gap: "Gap",
  comparison_style_borderRadius: "Corner radius",
  comparison_style_flexDirection: "Layout direction",
  comparison_style_justifyContent: "Main-axis alignment",
  comparison_style_alignItems: "Cross-axis alignment",
  extension_description: "Select UI elements and provide precise, local context for an agent.",
  open_ui_attach: "Open MeanThis",
  toolbar_unsupported_page: "MeanThis works on HTTP(S) pages. Open a web page and try again.",
  toolbar_content_unavailable:
    "MeanThis could not access this page. Reload it, then select MeanThis again.",
  toolbar_side_panel_unavailable:
    "MeanThis could not open its side panel. Reload the page, then try again.",
  add_page_element: "Add page element",
  element_capture: "Element capture",
  add_elements: "Add elements",
  first_capture_disclosure_heading: "Before your first capture",
  first_capture_disclosure_intro:
    "MeanThis creates references for elements you choose. Each reference may also include page and nearby context.",
  first_capture_disclosure_data:
    "A selected reference can include the page URL and title; the canonical top-page-to-selected-frame origin/path route; element structure, accessibility facts, labels, styles, bounds, locator and replay evidence, selected text (including hidden descendant text), nearby text, your task notes, optional source anchors, and iframe origin/path boundaries.",
  first_capture_disclosure_diagnostics:
    "If you turn on the optional one-shot private troubleshooting summary, it may include only replay result counts and coarse device, viewport, and touch classes. It does not include page content, addresses, exact dimensions, user agent, network or console data, screenshots, HAR, or debugger/CDP data. The option is off by default and applies only to the next capture. The private summary is copied only when you choose Copy summary; a connected local Agent may separately receive the disclosed coarse diagnostics.",
  first_capture_disclosure_local:
    "Captures and session state stay in this browser profile. Copies leave only when you choose to copy, export, or connect the optional local agent bridge.",
  first_capture_disclosure_redaction:
    "Agent-safe is the default and tries to redact likely sensitive text. Developer diagnostic keeps more route detail, and Full debug can retain recognized sensitive values. Screenshots and DOM snippets remain excluded; no mode guarantees that all sensitive information is removed.",
  first_capture_disclosure_receiver:
    "Copy for agent writes the handoff text to your system clipboard; Export writes a local file. Your browser, operating system, and applications that can access or receive those copies control them afterward. While the optional local agent bridge is connected, Agent-safe context refreshes automatically over that local connection.",
  first_capture_disclosure_first_trial:
    "For your first trial, use a non-sensitive, unauthenticated HTTP(S) page.",
  acknowledge_and_return: "I understand — return to Add elements",
  not_now: "Not now",
  review_data_disclosure: "Review data disclosure",
  stop_selecting: "Stop selecting",
  element_selection_help: "Click page elements to add them. Press Escape when done.",
  settings: "Settings",
  settings_title: "MeanThis settings",
  settings_intro:
    "Choose defaults for capture, task-note shortcuts, page access, and appearance. Simple settings save immediately; shortcuts save when you choose Add or Save.",
  settings_capture_privacy: "Capture and privacy",
  settings_capture_privacy_help:
    "Set the default amount of page-derived detail included in new captures.",
  content_detail_help:
    "Agent-safe is the recommended default for copying context to an Agent.",
  context_menu_selection_mode: "After right-click confirmation",
  context_menu_selection_single: "Stop after one element",
  context_menu_selection_continuous: "Keep selecting elements",
  context_menu_selection_mode_help:
    "Add page element starts the picker and previews the right-clicked target when available. Left-click confirms it. Continuous selection ends with Escape or Stop selecting.",
  frame_scope_auto_start: "Start selecting after changing scope",
  frame_scope_auto_start_help:
    "Off by default. When off, changing scope only changes where MeanThis will capture; choose Add elements when ready.",
  settings_relation_shortcuts: "Task note shortcuts",
  settings_relation_shortcuts_help:
    "Add optional shortcuts that fill the selected element's task note. Custom text stays on this device.",
  saved_shortcuts: "Saved shortcuts",
  relation_shortcuts_list_aria: "Saved task note shortcuts",
  relation_shortcuts_empty: "No custom shortcuts.",
  new_shortcut: "New shortcut",
  edit_shortcut: "Edit shortcut",
  shortcut_name: "Shortcut name",
  shortcut_name_placeholder: "Same spacing",
  shortcut_template: "Task note template",
  shortcut_template_placeholder: "Keep {selected} the same distance from {reference}.",
  shortcut_template_help: "Include both {selected} and {reference}. Up to eight custom shortcuts.",
  add_shortcut: "Add shortcut",
  save_shortcut_changes: "Save changes",
  cancel_shortcut_changes: "Cancel",
  remove_shortcut: "Remove",
  remove_shortcut_named: "Remove shortcut {name}",
  relation_shortcut_invalid:
    "Enter a name and a template containing both {selected} and {reference}.",
  relation_shortcut_limit_reached: "You can save up to eight custom shortcuts.",
  relation_shortcut_save_or_cancel_before_switching:
    "Save or cancel your changes before choosing another shortcut.",
  relation_shortcut_changes_cancelled: "Changes cancelled.",
  relation_shortcut_saved: "Shortcut saved.",
  relation_shortcut_removed: "Shortcut removed.",
  settings_page_access: "Page access",
  settings_page_access_help:
    "Control whether MeanThis follows ordinary web tabs without another toolbar click.",
  settings_appearance: "Appearance",
  settings_appearance_help:
    "Choose how the side panel and settings page follow your display.",
  settings_advanced: "Advanced",
  settings_advanced_help:
    "Override how captured detail is previewed and copied without changing future capture detail.",
  settings_saved: "Saved.",
  settings_load_failed: "Settings could not be loaded. Reload this page and try again.",
  settings_save_failed: "The setting could not be saved. Try again.",
  current_content_mode: "Current content mode",
  separate_content_modes: "Capture: {capture} · Copy: {copy}",
  capture_view_settings: "Capture and view settings",
  capture_mode: "Capture mode",
  view_as: "View as",
  content_detail: "Content detail",
  independent_preview_copy_mode: "Set preview and copy separately",
  independent_preview_copy_mode_help:
    "Off by default. Preview and copy follow content detail until this is turned on.",
  preview_copy_as: "Preview and copy as",
  theme: "Theme",
  time_display: "Time display",
  local_time_recommended: "Local time (recommended)",
  utc_time: "UTC",
  time_display_help:
    "This changes only visible timestamps. Stored and exported capture times remain UTC.",
  page_marker_visibility: "Page markers",
  page_markers_while_open: "While MeanThis is open (recommended)",
  page_markers_always: "Always on matching pages",
  page_marker_visibility_help:
    "Hiding page markers does not remove saved captures. Reopening MeanThis restores matching markers.",
  automatic_page_access: "Follow active tab automatically",
  automatic_page_access_help:
    "Optional. Chrome will ask for persistent access to all ordinary HTTP(S) websites. MeanThis still creates captures only after you choose Add elements.",
  automatic_page_access_enabled:
    "Automatic tab access is on. New HTTP(S) pages no longer require a toolbar click.",
  automatic_page_access_disabled:
    "Automatic tab access is off. New pages require a toolbar click.",
  automatic_page_access_denied:
    "Chrome did not grant automatic page access. The switch remains off.",
  system: "System",
  light: "Light",
  dark: "Dark",
  agent_safe: "Agent-safe",
  developer_diagnostic: "Developer diagnostic",
  full_debug: "Full debug",
  local_agent_bridge: "Local agent bridge",
  local_bridge_help: "Optional. Connect a local agent for read-only Agent-safe page context.",
  bridge_steps_aria: "Connection steps",
  bridge_step_choose_trust: "Choose access scope",
  bridge_step_choose_trust_help: "Allow one connection or trust this browser session.",
  bridge_step_create_request: "Create invitation",
  bridge_step_create_request_help: "MeanThis copies a two-minute local invitation.",
  bridge_step_agent_approve: "Agent accepts",
  bridge_step_agent_approve_help: "Paste the invitation into the agent on this device.",
  bridge_step_connected: "Connected",
  bridge_step_connected_help: "The agent can read current Agent-safe context.",
  trust: "Access scope",
  approval: "Approval",
  ask_every_time: "Allow one connection",
  trust_browser_session: "Trust this browser session",
  create_copy_request: "Create & copy invitation",
  local_bridge_preparing: "Preparing local connection…",
  local_bridge_preparing_help:
    "Checking and starting the local service. The first start may take a few seconds.",
  local_bridge_repairing: "Repairing and starting the local connection…",
  local_bridge_repairing_help:
    "Completing the approved local repair or setup and starting the service. This may take a few seconds.",
  copy_request_again: "Copy invitation again",
  cancel_request: "Cancel invitation",
  disconnect: "Disconnect",
  local_connection_request_aria: "Local agent connection invitation",
  bridge_trust_ask_help: "Create a new invitation for each connection.",
  bridge_trust_session_help: "After one accepted invitation, reconnect while this browser session and bridge owner remain active.",
  connection_details: "Connection details",
  local_bridge_security_detail: "The short-lived invitation stays on this device.",
  local_instance: "Local instance: {instanceId}",
  ready_to_connect: "Ready to connect. Choose an access scope.",
  not_connected: "Not connected.",
  no_origin: "No origin",
  ready_add_elements: "Ready to attach UI. Start with Add elements.",
  in_page_widget_starting: "MeanThis is starting\u2026",
  in_page_widget_start_failed: "MeanThis could not start",
  in_page_widget_region_label: "MeanThis page references",
  in_page_widget_selection_toolbar_label: "Selection controls",
  in_page_widget_selected_targets_label: "Selected targets",
  in_page_widget_open_label: "Open MeanThis, {count} selected, {state}",
  in_page_widget_close: "Collapse MeanThis",
  in_page_widget_copy_for_agent: "Copy current references for agent",
  in_page_widget_clear_all: "Clear all selected elements",
  in_page_widget_clear_confirm: "Select Clear again to remove all selected elements.",
  in_page_widget_retry_clear: "Retry clearing page annotations",
  in_page_widget_clear_pending:
    "Clearing page annotations is still pending. Retry to confirm completion.",
  in_page_widget_open_settings: "Open MeanThis details and settings",
  in_page_widget_open_full_side_panel: "Open full side panel",
  in_page_widget_opening_full_side_panel: "Opening full side panel…",
  in_page_widget_full_side_panel_opened: "Full side panel opened.",
  in_page_widget_full_side_panel_open_failed: "MeanThis could not open the full side panel.",
  in_page_widget_reference_scope_label: "Reference scope",
  in_page_widget_current_page_scope: "Current page · {count}",
  in_page_widget_entire_site_scope: "Entire {site} site · {count}",
  in_page_widget_other_pages_count: "{count} on other pages",
  in_page_widget_clear_current_page: "Clear references from the current page",
  in_page_widget_clear_entire_site: "Clear references from the entire {site} site",
  in_page_widget_clear_current_page_confirm:
    "Select Clear again to remove references from the current page.",
  in_page_widget_clear_entire_site_confirm:
    "Select Clear again to remove references from the entire {site} site.",
  in_page_widget_output_detail_label: "Output detail",
  in_page_widget_output_detail_help:
    "Controls copied text only. MeanThis keeps the full captured reference.",
  in_page_widget_output_detail_compact: "Compact",
  in_page_widget_output_detail_standard: "Standard",
  in_page_widget_output_detail_detailed: "Detailed",
  in_page_widget_output_detail_forensic: "Forensic",
  in_page_widget_collect_basic_diagnostics_label:
    "Add a private troubleshooting summary to the next capture",
  in_page_widget_collect_basic_diagnostics_help:
    "Includes replay result counts and coarse device classes. No page content, address, exact size, user agent, network, console, screenshot, or HAR. Used once. This summary is copied only when you choose Copy summary; a connected local Agent may separately receive the disclosed coarse diagnostics.",
  in_page_widget_private_debug_summary_ready: "Troubleshooting summary ready",
  in_page_widget_private_debug_summary_not_copied: "Not copied yet",
  in_page_widget_private_debug_summary_replay:
    "{verifiedCount} verified · {ambiguousCount} ambiguous · {missingCount} missing",
  in_page_widget_private_debug_summary_replay_unavailable: "Replay summary unavailable",
  in_page_widget_private_debug_summary_device:
    "{deviceClass} · {viewportClass} viewport · {touch}",
  in_page_widget_private_debug_summary_device_desktop: "Desktop",
  in_page_widget_private_debug_summary_device_tablet: "Tablet",
  in_page_widget_private_debug_summary_device_mobile: "Mobile",
  in_page_widget_private_debug_summary_viewport_small: "Small",
  in_page_widget_private_debug_summary_viewport_medium: "Medium",
  in_page_widget_private_debug_summary_viewport_large: "Large",
  in_page_widget_private_debug_summary_touch_none: "No touch",
  in_page_widget_private_debug_summary_touch_coarse: "Coarse touch",
  in_page_widget_private_debug_summary_touch_unknown: "Touch unknown",
  in_page_widget_private_debug_summary_device_unavailable: "Device summary unavailable",
  in_page_widget_copy_private_debug_summary: "Copy summary",
  in_page_widget_copying_private_debug_summary: "Copying summary…",
  in_page_widget_private_debug_summary_copied:
    "Troubleshooting summary copied.",
  in_page_widget_private_debug_summary_copy_failed:
    "Copy failed. Select the troubleshooting summary shown below to copy it manually.",
  in_page_widget_annotation_display_label: "Annotation display",
  in_page_widget_annotation_display_full: "Full",
  in_page_widget_annotation_display_hover: "Hover",
  in_page_widget_annotation_display_markers: "Markers",
  in_page_widget_annotation_display_hidden: "Hidden",
  in_page_widget_lifecycle_control_proposal: "Agent lifecycle proposal",
  in_page_widget_lifecycle_control_proposal_fingerprint: "Fingerprint: {fingerprint}",
  in_page_widget_lifecycle_control_proposal_transition:
    "Transition: {expected} → {next}",
  in_page_widget_lifecycle_control_proposal_expires: "Expires: {expiresAt}",
  in_page_widget_lifecycle_control_proposal_approve: "Approve",
  in_page_widget_lifecycle_control_proposal_reject: "Reject",
  in_page_widget_bridge_unavailable: "Agent bridge unavailable",
  in_page_widget_bridge_disconnected: "Disconnected",
  in_page_widget_bridge_pending: "Connecting",
  in_page_widget_bridge_connected: "Connected",
  in_page_widget_selected_count: "{count} selected",
  in_page_widget_open_target: "Open target {label}: {name}",
  in_page_widget_target_heading: "Target {label}",
  in_page_widget_edit_target: "Edit target {label}",
  in_page_widget_remove_target: "Remove target {label}",
  in_page_widget_more_target: "More options for target {label}",
  in_page_widget_close_editor: "Close task editor for target {label}",
  in_page_widget_edit: "Edit",
  in_page_widget_more: "More",
  annotation_details: "Show annotation details",
  in_page_widget_task_note_label: "Task note for target {label}",
  in_page_widget_save: "Save",
  in_page_widget_saving: "Saving…",
  in_page_widget_copying: "Copying…",
  in_page_widget_disclosure_acknowledging: "Saving acknowledgement…",
  in_page_widget_disconnected: "MeanThis page tools disconnected. Open MeanThis again.",
  in_page_widget_task_note_save_failed: "Task note was not saved.",
  in_page_widget_task_note_saved: "Task note saved.",
  in_page_widget_copy_succeeded: "Copied {count} elements for agent.",
  in_page_widget_copy_failed: "Copy failed. Select the text shown below to copy it manually.",
  in_page_widget_reconnecting: "MeanThis page tools are reconnecting…",
  in_page_widget_operation_failed: "MeanThis action failed.",
  in_page_widget_session_not_ready: "The current page session is not ready yet.",
  in_page_widget_disclosure_load_failed:
    "MeanThis could not check the capture disclosure. Try again.",
  in_page_widget_disclosure_acknowledge_failed:
    "MeanThis could not save your acknowledgement. Try again.",
  in_page_widget_shortcut_below: "Place below",
  in_page_widget_shortcut_below_note: "Place {label} below the reference element.",
  in_page_widget_bridge_controls_label: "Local agent connection",
  in_page_widget_bridge_unavailable_help: "The local agent bridge is unavailable.",
  in_page_widget_bridge_disconnected_help:
    "Create a short-lived invitation for a local agent.",
  in_page_widget_bridge_pending_help:
    "Copy this invitation into the local agent, then refresh the connection.",
  in_page_widget_bridge_pending_countdown:
    "Waiting for the agent to accept · Expires in {remaining}",
  in_page_widget_bridge_connected_help:
    "Agent-safe page context is available to the connected local agent.",
  in_page_widget_create_invitation: "Create connection invitation",
  in_page_widget_creating_invitation: "Creating invitation…",
  in_page_widget_copy_invitation: "Copy invitation",
  in_page_widget_refresh_connection: "Refresh",
  in_page_widget_refreshing_connection: "Refreshing…",
  in_page_widget_disconnecting: "Disconnecting…",
  workflow_heading: "Attach UI in three steps",
  describe_change: "Describe the change",
  describe_change_help: "Write the result you want.",
  copy_for_agent: "Copy for agent",
  copy_for_agent_count: "Copy for agent ({count})",
  copy_for_agent_help: "Review the selected labels, then copy the handoff.",
  layout_relationship_optional: "Use a task note shortcut (optional)",
  copy_content_recovery: "Copy options",
  handoff_format: "Handoff detail",
  handoff_format_exact: "Full detail",
  handoff_format_compact: "Compact (token-efficient)",
  view_exact_handoff: "Preview copy content",
  agent_handoff_preview_help:
    "This is the exact text used by Copy for agent. You can copy it manually if browser clipboard access fails.",
  agent_handoff_preview_aria: "Agent handoff preview",
  add_elements_help: "Select Add elements, then click each page target.",
  session: "Selected elements",
  editing_target: "Editing {label} · {target}",
  target_details: "Target details",
  captured_page: "Captured page",
  unsaved_task_note: "Unsaved task note",
  captured_page_unavailable: "Captured page unavailable",
  captured_page_elsewhere: "This target was captured on another page. Open its page, then restore or recheck the target.",
  open_captured_page: "Open captured page",
  elements_count: "{count} of 26 elements",
  clear_selected_elements: "Clear selected elements",
  captured_elements_aria: "Captured elements",
  captured_targets: "Captured targets",
  current_page: "Current page",
  other_page: "Other page",
  embedded_frame: "Embedded frame",
  embedded_frame_boundary_notice:
    "MeanThis captured the embedded frame boundary, not its internal page. Use Capture scope above to work inside the frame, or use a frame-aware browser tool.",
  capture_scope: "Capture scope",
  top_page: "Top page",
  current_scope: "Current scope",
  in_page_widget_all_scopes_count: "{count} across scopes",
  capture_scope_auto_close_help:
    "Selecting a scope closes this tree. Press Escape to close.",
  capture_scope_unavailable: "This frame is not available for element selection.",
  frame_scope_selection_enabled:
    "Element selection is enabled in the chosen scope. Click elements, then press Escape.",
  frame_scope_changed: "Capture scope changed. Choose Add elements when ready.",
  embedded_frame_scope: "Embedded frame",
  frame_permission_denied:
    "Frame access was not granted. Nothing inside the frame was captured.",
  frame_permission_unavailable:
    "Frame access is unavailable in this browser. Reload the extension and try again.",
  frame_unavailable:
    "The embedded frame changed or could not be found. Capture its boundary again.",
  frame_ambiguous:
    "More than one matching embedded frame is open. MeanThis will not guess which one you intended.",
  frame_permission_cleanup_failed:
    "Chrome could not release temporary frame access. Selection was stopped; review MeanThis site access in the extension settings.",
  other_tab: "Other tab",
  unsaved_intent_attention: "Unsaved intent needs attention.",
  retry_save: "Retry save",
  discard_changes: "Discard changes",
  advanced_session_tools: "Advanced session tools",
  source_export_help:
    "Export the complete source-bound session JSON for diagnostics and local checkout tools. Normal use does not require this.",
  export_source_session: "Export source session",
  saved_sites: "Saved captures",
  saved_sites_help: "Review, reopen, restore, or clear UI references saved on this device.",
  saved_sites_aria: "Saved captures",
  saved_site_count_aria: "Saved captures: {count}",
  no_saved_site_sessions: "No saved captures.",
  saved_sites_unavailable: "Saved captures are unavailable. Try again.",
  saved_site_target_one: "1 target",
  saved_site_target_many: "{count} targets",
  saved_site_needs_cleanup: "Needs cleanup",
  review_saved_site: "Review",
  review_saved_site_aria: "Review saved references for {origin}",
  back_to_saved_sites: "Back to saved captures",
  saved_snapshot_read_only: "Saved capture · Local",
  saved_review_help:
    "Capture-time Agent-safe summary. Find the original tab or a matching frame on the current page to recheck its targets.",
  saved_routes_heading: "Captured routes",
  saved_routes_unavailable: "No reusable page route was retained for this capture.",
  saved_route_top: "Top-level page",
  restore_current_page: "Restore markers on this page",
  find_and_restore_saved_route: "Find and restore",
  open_saved_page: "Open page",
  copy_page_address: "Copy address",
  page_address_copied: "Page address copied.",
  saved_page_opened:
    "Page opened. If restore is unavailable there, invoke MeanThis once from the toolbar.",
  saved_restore_result:
    "Restore result: {restored} restored · {missing} missing · {ambiguous} ambiguous.",
  saved_restore_workspace_ready:
    "Restored {restored} targets. You can continue editing task notes or copy for agent. {missing} missing · {ambiguous} ambiguous.",
  saved_restore_failed:
    "Could not restore these markers. Make sure the saved route is open and unique.",
  saved_route_not_found:
    "MeanThis did not find this saved frame in its original tab or the current page. Open the page that contains it and try again.",
  saved_route_ambiguous:
    "More than one matching frame is open. Choose the intended frame in Capture scope, then try again.",
  saved_review_empty: "This saved session has no targets.",
  saved_review_task_note: "Task note: {intent}",
  saved_review_capture_details: "Capture details",
  saved_review_failed: "Saved capture is unavailable. Refresh Saved captures and try again.",
  saved_review_changed: "Saved data changed. Review it again to see the latest snapshot.",
  saved_handoff_authority: "Capture-time record · not rechecked",
  saved_handoff_authority_help: "Live page routing is omitted. Recheck the page before any control action.",
  saved_handoff_preview_summary: "View what will be copied",
  saved_handoff_preview_aria: "Saved snapshot agent handoff preview",
  copy_saved_handoff: "Copy this snapshot for agent",
  saved_bundle_json_summary: "Developer and integration options",
  saved_bundle_json_help: "Review and copy the exact structured Agent-safe JSON for a compatible consumer. Live page routing and control authority stay omitted.",
  saved_bundle_json_preview_aria: "Saved snapshot machine-readable bundle JSON preview",
  copy_saved_bundle_json: "Copy bundle JSON",
  saved_handoff_copied: "Snapshot copied for agent.",
  saved_bundle_json_copied: "Saved bundle JSON copied for a compatible consumer.",
  saved_handoff_failed: "Saved snapshot handoff is stale or unavailable. Review the saved capture again.",
  saved_handoff_clipboard_failed: "Could not copy the saved snapshot. The preview remains available.",
  saved_bundle_json_clipboard_failed: "Could not copy the saved bundle JSON. The reviewed snapshot remains available.",
  clear_saved_site: "Clear",
  retry_clear: "Retry clear",
  clear_saved_site_aria: "Clear saved data for {origin}",
  clear_all_saved_captures: "Clear all saved captures",
  saved_site_cleared: "Saved capture cleared.",
  all_saved_captures_cleared: "All saved captures cleared.",
  saved_sites_action_failed: "Saved-capture action failed. Try again.",
  selected_element: "Selected element",
  no_element: "No element",
  captured: "Captured",
  none: "none",
  redacted: "Redacted",
  sensitive_hints: "Sensitive hints",
  included_sensitive: "Included sensitive",
  relation_help:
    "A shortcut writes a task note only for the current task element. The reference element is not given its own task.",
  relation_role_summary: "Task element: {source} · Reference element: {reference}",
  relation_applied_feedback:
    "Task note added to {source}; {reference} is used only as a reference.",
  element: "Element",
  element_to_change_aria: "Element to change",
  relationship: "Shortcut",
  use_in_task_note: "Generate and fill",
  swap_elements: "Swap elements",
  swap_elements_aria: "Swap selected element and reference",
  relative_to: "Relative to",
  reference_element_aria: "Reference element",
  relationship_action_aria: "Task note shortcut",
  below: "Below",
  above: "Above",
  left_of: "Left of",
  right_of: "Right of",
  align_left: "Align left",
  match_width: "Match width",
  change_relationship: "Change shortcut",
  task: "Task note for selected element",
  intent_placeholder: "Describe the result you want",
  agent_summary: "Agent summary",
  advanced_attachment_data: "Developer diagnostics",
  developer_diagnostics_help:
    "Raw metadata and separate Markdown/JSON copies for debugging integrations.",
  prompt_markdown: "Prompt markdown",
  attachment_json: "Attachment JSON",
  copy_markdown: "Copy markdown",
  copy_json: "Copy JSON",
  panel_action_failed: "Panel action failed. Try again.",
  request_copied: "Invitation copied. Paste it into the local agent so it can accept the connection.",
  connection_invitation_expired: "Connection invitation expired. Create a new invitation.",
  request_ready: "Invitation ready. Copy the text below into the local agent.",
  copied_markdown: "Copied markdown.",
  copied_json: "Copied JSON.",
  copied_agent_context: "Copied agent context.",
  copied_elements_for_agent: "Copied {count} elements for agent.",
  agent_handoff_copy_next_step:
    "Paste the handoff into the text agent you want to use. MeanThis does not run page actions.",
  agent_handoff_context_only_next_step:
    "Paste the handoff, then tell the agent what you want it to do. MeanThis does not run page actions.",
  local_connection_failed: "Local agent connection failed. Try again.",
  local_companion_unavailable: "The MeanThis local companion is not installed or unavailable.",
  local_bridge_repair_required: "The local connection needs repair. MeanThis did not overwrite an unsafe credential or unknown listener.",
  local_bridge_setup_required: "The local companion needs to finish its one-time Agent setup before creating an invitation.",
  local_bridge_action_required: "Another or older process owns the local bridge port. Stop it manually, then try again; MeanThis did not rotate credentials or terminate it.",
  local_bridge_start_failed: "MeanThis could not start the local connection. Try again.",
  confirm_local_bridge_repair: "The local credential needs repair. Rotate the local MeanThis credentials and start the bridge now? Existing Agent tasks may need to be reopened.",
  confirm_local_bridge_setup: "Finish the local MeanThis Agent setup and start the bridge now?",
  local_bridge_repaired_retry: "The local connection was repaired. Select Create invitation again.",
  local_status_unavailable: "Local agent status unavailable.",
  local_bridge_read_ack_waiting: "Waiting for the Agent client to retrieve the current share.",
  local_bridge_read_ack_current: "The Agent client confirmed retrieval of the current share.",
  local_bridge_read_ack_unavailable:
    "Unable to confirm whether the Agent client retrieved the current share.",
  local_bridge_read_ack_limitations: "This does not mean the Agent understood or executed it.",
  connected_local: "Connected. Agent-safe page context is available to the local agent.",
  connected_local_targets: "Connected. The local agent can read {count} selected elements.",
  connected_no_selection: "Connected. Select an element in this panel to share Agent-safe context.",
  connected_share_unavailable: "Connected, but the current selection is not available to share yet. Reopen its page and MeanThis will retry automatically.",
  waiting_approval: "Waiting for the agent to accept. This invitation expires at {expiresAt}.",
  waiting_approval_bridge_unavailable: "Waiting for the agent to accept. The bridge is temporarily unavailable.",
  connected_agent_unreachable: "Connected. The local capture state has not finished syncing; MeanThis is retrying automatically.",
  selection_enabled: "Selection enabled. Click page elements to add them. Press Escape when done.",
  capture_mode_set: "Content detail set to {mode}.",
  no_targets_page: "No targets captured on this page yet.",
  session_count_current_elsewhere: "{current} on this page · {elsewhere} elsewhere · {total} total",
  session_count_current: "{current} on this page",
  session_count_total: "{count} of 26 elements",
  handoff_scope_one: "1 target from the selected page will be copied.",
  handoff_scope_many: "{count} targets from the selected page will be copied.",
  handoff_scope_intents: "Requested work: {taskCount} · Context only: {contextCount}.",
  handoff_scope_context_only_help:
    "No request is included. After pasting, tell the agent what you want it to do.",
  handoff_scope_all_noted: "Every element has its own task note.",
  handoff_scope_partially_noted_one:
    "Task notes are included for {taskCount} of {count} elements; the remaining element provides page context or serves as a reference without a standalone task.",
  handoff_scope_partially_noted_many:
    "Task notes are included for {taskCount} of {count} elements; the remaining {contextCount} elements provide page context or serve as references without standalone tasks.",
  handoff_scope_none_noted:
    "No standalone task notes are included. After pasting, tell the agent what you want it to do.",
  handoff_scope_elsewhere: "{count} saved elsewhere are excluded.",
  task_note_added: "Has task note",
  task_note_missing: "No standalone task",
  session_group_aria_one: "{label}, 1 target",
  session_group_aria_many: "{label}, {count} targets",
  source: "Source",
  remove: "Remove",
  remove_selected_element: "Remove selected element",
  open_annotation_actions: "Open actions for annotation",
  remove_aria: "Remove {label}: {target}",
  confirm_discard_intent: "Discard unsaved intent before removing this item?",
  confirm_clear_selection_dirty:
    "Clear selected elements for this page and its embedded frames? Saved selections for every affected site and unsaved task notes will also be discarded.",
  confirm_clear_selection:
    "Clear selected elements for this page and its embedded frames? Saved selections for every affected site will be discarded.",
  confirm_clear_saved_site:
    "Clear the saved UI reference session for {origin}? Captured targets and intents for this site will be removed.",
  confirm_clear_saved_site_dirty:
    "Clear the saved UI reference session for {origin}? Captured targets and the unsaved task note currently being edited for this site will be removed.",
  confirm_clear_all_saved_sites:
    "Clear every saved UI reference session? Captured targets and intents for all sites will be removed. Extension preferences, exported files, and clipboard contents are not cleared.",
  clipboard_failed: "Clipboard write failed. Select the text and copy manually.",
  agent_handoff_clipboard_failed:
    "Clipboard write failed. The handoff is selected below for manual copy.",
  unsupported_page: "This page is not supported. Open an HTTP(S) page to capture UI.",
  source_export_warning_data: "This file preserves original capture data. The current preview mode does not make it Agent-safe.",
  source_export_warning_intent: "This file includes per-item user intent.",
  no_selected_capture: "No selected capture.",
  unable_prepare_agent_context: "Unable to prepare agent context.",
  no_capture_session: "No capture session.",
  invalid_capture_session: "Stored capture session is invalid.",
  saving_session: "Saving session...",
  session_saved: "Session saved locally.",
  session_item_removed: "Session item removed.",
  selection_cleared: "Selected elements cleared. The next element you add will be A.",
  session_unchanged: "Capture was not added. Your existing session is unchanged.",
  session_full: "Session limit reached (26 elements). Remove one or clear the selected elements.",
  clear_in_progress: "Selected elements are still being cleared. Retry before capturing or exporting.",
  export_started_named: "Export started: {filename}. Check your browser downloads.",
  export_started: "Export started. Check your browser downloads.",
  active_origin_changed: "Active origin changed. Save or discard the pending intent.",
  capture_failed_with_message: "Capture failed: {message}",
  unable_capture_selected: "Unable to capture the selected element.",
  copied: "Copied.",
  capture_ready: "Capture ready.",
  page_cannot_capture: "This page cannot be captured. Open a regular HTTP(S) page, then try again.",
  open_regular_page: "Open a regular HTTP(S) page, then select Add elements again.",
  content_unavailable: "MeanThis cannot reach this page. Reload it, then select Add elements again.",
  permission_recovery: "Page access is required before selection.",
  page_access_recovery_heading: "Reconnect this page",
  page_access_permission_reason:
    "MeanThis does not have access to this page yet. Choose automatic access below, or grant temporary access from the toolbar.",
  page_access_content_heading: "Reload and reconnect",
  page_access_content_reason: "MeanThis lost access after this page loaded or changed.",
  page_access_step_keep_active: "Keep this page active.",
  page_access_step_reload: "Reload this page.",
  page_access_step_toolbar: "Select MeanThis in the browser toolbar.",
  page_access_step_retry: "Select Add elements again.",
  page_access_toolbar_cue: "Browser toolbar",
  page_access_limit:
    "Keep this side panel open. After you select MeanThis in the toolbar, it refreshes automatically.",
  page_access_automatic_explanation:
    "Chrome will keep MeanThis authorized for ordinary HTTP(S) pages. MeanThis captures only after you choose Add elements or another explicit capture action.",
  page_access_enable_automatic: "Enable automatic access to web pages",
  page_access_enabling_automatic: "Enabling automatic access…",
  page_access_automatic_denied:
    "Automatic page access was not granted. Use the toolbar for temporary access, or try again.",
  page_access_automatic_failed:
    "Automatic page access could not be enabled. Use the toolbar for temporary access, or try again.",
  page_access_automatic_not_ready:
    "Automatic access is on, but MeanThis still cannot access this page. Reload it or use the toolbar for temporary access.",
  page_access_temporary_path: "For temporary access to only this page:",
  selection_generic_recovery: "MeanThis could not start selection. Reload the page and try again.",
  page_changed_recovery: "The page changed before capture finished. Select Add elements and choose the target again.",
  capture_generic_recovery: "Capture failed. Select Add elements and choose the target again.",
  selection_stopped_with_elements: "Selection stopped. Review the captured elements or select Add elements to continue.",
  selection_stopped_empty: "Selection stopped. Select Add elements when you are ready to continue.",
  unnamed: "unnamed",
  no_primary_locator: "No primary locator",
  locator_summary: "{strategy} · confidence {confidence} · {replay}",
  replay_verified: "capture-time replay verified",
  current_target_checking: "Current page: checking target…",
  current_target_restored: "Current page: target restored.",
  current_target_missing:
    "Current page: target not found. Select Add elements to capture it again, then remove this stale item.",
  current_target_ambiguous:
    "Current page: multiple matching targets. Select Add elements to capture the intended target again, then remove this stale item.",
  current_target_unavailable:
    "Current page: target status unavailable. Reload the page, or capture it again and remove this stale item.",
  replay_failed: "replay failed: {reason}",
  replay_not_verified: "replay not verified",
  choose_two_elements: "Choose two captured elements.",
  choose_different_elements: "Choose two different elements.",
  relation_intent_below: "Move {source} below {reference}.",
  relation_intent_above: "Move {source} above {reference}.",
  relation_intent_left_of: "Move {source} to the left of {reference}.",
  relation_intent_right_of: "Move {source} to the right of {reference}.",
  relation_intent_align_left: "Align {source}'s left edge with {reference}'s left edge.",
  relation_intent_match_width: "Match {source}'s width to {reference}'s width.",
  relation_label_below: "{source} below {reference}",
  relation_label_above: "{source} above {reference}",
  relation_label_left_of: "{source} left of {reference}",
  relation_label_right_of: "{source} right of {reference}",
  relation_label_align_left: "Align {source} left to {reference}",
  relation_label_match_width: "Match {source} width to {reference}",
} as const;

export type UiAttachMessageValues = Record<string, string | number>;
export type UiAttachTranslate = (key: string, values?: UiAttachMessageValues) => string;

const SIMPLIFIED_CHINESE_WIDGET_LIFECYCLE_MESSAGES: Readonly<Record<string, string>> =
  Object.freeze({
    in_page_widget_mark_resolved: "标为已解决",
    in_page_widget_reopen: "重新打开",
    in_page_widget_resolved: "已解决",
    in_page_widget_annotation_resolved: "批注已解决。",
    in_page_widget_annotation_reopened: "批注已重新打开。",
    in_page_widget_annotation_lifecycle_unconfirmed: "批注状态未更新，请刷新后重试。",
    in_page_widget_mark_annotation_resolved: "将批注 {label} 标为已解决",
    in_page_widget_reopen_annotation: "重新打开批注 {label}",
    in_page_widget_lifecycle_control_proposal: "Agent 生命周期提案",
    in_page_widget_lifecycle_control_proposal_fingerprint: "指纹：{fingerprint}",
    in_page_widget_lifecycle_control_proposal_transition:
      "状态变更：{expected} → {next}",
    in_page_widget_lifecycle_control_proposal_expires: "过期时间：{expiresAt}",
    in_page_widget_lifecycle_control_proposal_approve: "批准",
    in_page_widget_lifecycle_control_proposal_reject: "拒绝",
  });

export function translateWidgetLifecycleMessage(language: string, key: string): string | null {
  return /^(?:zh)(?:[-_]|$)/iu.test(language.trim())
    ? SIMPLIFIED_CHINESE_WIDGET_LIFECYCLE_MESSAGES[key] ?? null
    : null;
}

export interface UiAttachI18n {
  language: string;
  t: UiAttachTranslate;
}

export interface UiAttachBrowserI18nApi {
  getMessage(key: string): string;
  getUILanguage?(): string;
}

export function createUiAttachI18n(api?: UiAttachBrowserI18nApi): UiAttachI18n {
  let language = "en";
  try {
    language = api?.getUILanguage?.().trim() || "en";
  } catch {
    // English is the deterministic fallback when browser locale state is unavailable.
  }
  return {
    language,
    t(key, values = {}) {
      const fallback = ENGLISH_MESSAGES[key as keyof typeof ENGLISH_MESSAGES] ?? key;
      let message: string = fallback;
      try {
        message = api?.getMessage(key) || fallback;
      } catch {
        // A missing or unavailable catalog must never make the extension UI unusable.
      }
      return fillNamedValues(message, values);
    },
  };
}

export const translateEnglish: UiAttachTranslate = createUiAttachI18n().t;

export function localizeDocument(root: Document, i18n: UiAttachI18n): void {
  root.documentElement.lang = i18n.language.replace("_", "-");
  applyLocalizedAttribute(root, "data-i18n", (element, value) => {
    element.textContent = value;
  }, i18n);
  applyLocalizedAttribute(root, "data-i18n-placeholder", (element, value) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.placeholder = value;
    }
  }, i18n);
  applyLocalizedAttribute(root, "data-i18n-aria-label", (element, value) => {
    element.setAttribute("aria-label", value);
  }, i18n);
  applyLocalizedAttribute(root, "data-i18n-title", (element, value) => {
    element.setAttribute("title", value);
  }, i18n);
}

function applyLocalizedAttribute(
  root: Document,
  attribute: string,
  apply: (element: HTMLElement, value: string) => void,
  i18n: UiAttachI18n,
): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    const key = element.getAttribute(attribute);
    if (key) apply(element, i18n.t(key));
  }
}

function fillNamedValues(message: string, values: UiAttachMessageValues): string {
  return message.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) => (
    Object.hasOwn(values, name) ? String(values[name]) : token
  ));
}
