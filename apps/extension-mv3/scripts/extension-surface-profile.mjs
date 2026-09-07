const SURFACE_PROFILES = new Set(["consumer", "development"]);
export const BRIDGE_MESSAGE_KEYS = Object.freeze([
  "approval",
  "ask_every_time",
  "bridge_step_agent_approve",
  "bridge_step_agent_approve_help",
  "bridge_step_choose_trust",
  "bridge_step_choose_trust_help",
  "bridge_step_connected",
  "bridge_step_connected_help",
  "bridge_step_create_request",
  "bridge_step_create_request_help",
  "bridge_steps_aria",
  "bridge_trust_ask_help",
  "bridge_trust_session_help",
  "cancel_request",
  "connected_agent_unreachable",
  "connected_local",
  "connection_details",
  "copy_request_again",
  "create_copy_request",
  "disconnect",
  "first_capture_disclosure_local",
  "first_capture_disclosure_receiver",
  "local_agent_bridge",
  "local_bridge_help",
  "local_bridge_security_detail",
  "local_connection_failed",
  "local_connection_request_aria",
  "local_instance",
  "local_status_unavailable",
  "not_connected",
  "ready_to_connect",
  "request_copied",
  "request_ready",
  "trust",
  "trust_browser_session",
  "waiting_approval",
  "waiting_approval_bridge_unavailable",
]);

export function parseExtensionSurfaceProfile(value) {
  if (!SURFACE_PROFILES.has(value)) {
    throw new Error("Unsupported extension surface profile.");
  }
  return value;
}

export function extensionProfileOutDir(profile) {
  return parseExtensionSurfaceProfile(profile) === "consumer" ? "dist-consumer" : "dist";
}

export function projectExtensionManifest(manifest, profile) {
  const parsedProfile = parseExtensionSurfaceProfile(profile);
  const projected = structuredClone(manifest);
  if (parsedProfile === "development") {
    projected.host_permissions = ["http://127.0.0.1/*"];
    projected.optional_host_permissions = (projected.optional_host_permissions ?? [])
      .filter((origin) => origin !== "http://127.0.0.1/*");
    projected.externally_connectable = {
      matches: ["http://127.0.0.1/*"],
    };
  } else {
    delete projected.host_permissions;
    delete projected.externally_connectable;
  }
  return projected;
}

export function projectExtensionLocaleMessages(messages, profile) {
  parseExtensionSurfaceProfile(profile);
  if (messages === null || typeof messages !== "object" || Array.isArray(messages)) {
    throw new Error("Extension locale catalog is invalid.");
  }
  return structuredClone(messages);
}
