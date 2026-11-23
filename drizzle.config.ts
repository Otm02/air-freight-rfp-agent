const drizzleConfig = {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:./data/rfp.db",
  },
};

export default drizzleConfig;
