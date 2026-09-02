import cron from "node-cron";

export function startCronJob() {
    // Ping the backend every 14 minutes to prevent Render free tier from sleeping
    cron.schedule("*/14 * * * *", async () => {
        try {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`;
            console.log(`[Cron] Executing keep-alive ping to ${url}/api/health`);

            const response = await fetch(`${url}/api/health`, {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            });

            if (response.ok) {
                console.log(`[Cron] Keep-alive ping successful at ${new Date().toISOString()}`);
            } else {
                console.log(`[Cron] Keep-alive ping returned status: ${response.status}`);
            }
        } catch (error) {
            console.error(`[Cron] Keep-alive ping failed:`, error.message);
        }
    });

    console.log("⏰ Self-ping cron job service initialized. (Runs every 14 minutes)");
}
