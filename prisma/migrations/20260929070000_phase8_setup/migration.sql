-- AlterTable
ALTER TABLE "practices" ADD COLUMN     "report_viewed_at" TIMESTAMPTZ,
ADD COLUMN     "setup_skipped" TEXT[] DEFAULT ARRAY[]::TEXT[];

