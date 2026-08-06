export const EXTENSION_SURFACE_PROFILES = ["consumer", "development"] as const;

export type ExtensionSurfaceProfile = (typeof EXTENSION_SURFACE_PROFILES)[number];

declare const __UI_ATTACH_SURFACE_PROFILE__: ExtensionSurfaceProfile;

export const EXTENSION_SURFACE_PROFILE = __UI_ATTACH_SURFACE_PROFILE__;
