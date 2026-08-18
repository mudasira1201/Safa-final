import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const jobId = "cmsrozlyu0000no1ezovj9xwb";
const projectId = "cmsr5wds80001cr3he47rlfe3";
let last = "";
let consecutiveErrors = 0;

while (true) {
  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    consecutiveErrors = 0;
    if (!job) { console.log("job row gone"); break; }
    const line = `${job.status} | ${job.stage} | ${job.progress}% | attempts=${job.attempts}`;
    if (line !== last) {
      console.log(line + (job.error ? ` | error: ${job.error.split("\n")[0]}` : ""));
      last = line;
    }
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      const clipCount = Array.isArray(project?.clipsJson) ? project.clipsJson.length : 0;
      console.log(`TERMINAL: job=${job.status} project.status=${project?.status} clips=${clipCount}`);
      break;
    }
  } catch (e) {
    consecutiveErrors++;
    console.log(`(transient DB error, retrying: ${e?.message?.split("\n")[0]})`);
    if (consecutiveErrors >= 10) { console.log("giving up after repeated DB errors"); break; }
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await prisma.$disconnect();
