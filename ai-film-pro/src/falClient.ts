import { fal } from "@fal-ai/client";
import { config } from "./config";

fal.config({ credentials: config.falKey });

export { fal };
