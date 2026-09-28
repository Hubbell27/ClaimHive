process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ??
  "postgresql://claimhive_app@localhost:5433/claimhive_test?host=/var/tmp/intake-pg";
process.env.MASTER_KEY = "dGVzdC1vbmx5LWNsYWltaGl2ZS1tYXN0ZXIta2V5MzI=";
process.env.KEY_PROVIDER = "local";
