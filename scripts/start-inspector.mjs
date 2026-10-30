import { once } from "node:events";
import { getProfiles, loadLocalEnv, startInspector } from "./profile-runtime.mjs";

await loadLocalEnv();

const profileId = process.argv[2];
if (!profileId) {
  const profiles = await getProfiles();
  console.error(`Usage: npm run inspect:profile -- <${profiles.map(({ id }) => id).join("|")}>`);
  process.exitCode = 2;
} else {
  try {
    const { child, cleanup } = await startInspector(profileId);
    console.log(`Starting MCP Inspector profile: ${profileId}`);
    const [code, signal] = await once(child, "close");
    await cleanup();
    process.exitCode = signal ? 1 : code ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}