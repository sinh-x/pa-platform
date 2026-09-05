declare module "#pi-pa-vimmode" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  const register: (pi: ExtensionAPI) => void;
  export default register;
}

declare module "#pi-pa-proper-base" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  const register: (pi: ExtensionAPI) => void;
  export default register;
}
