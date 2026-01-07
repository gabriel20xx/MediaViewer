-- CreateTable
CREATE TABLE "MediaItem" (
    "id" TEXT NOT NULL,
    "relPath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "modifiedMs" BIGINT NOT NULL,
    "hasFunscript" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybackState" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "timeMs" INTEGER NOT NULL,
    "fps" INTEGER NOT NULL DEFAULT 30,
    "frame" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybackState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaItem_relPath_key" ON "MediaItem"("relPath");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybackState_clientId_mediaId_key" ON "PlaybackState"("clientId", "mediaId");

-- AddForeignKey
ALTER TABLE "PlaybackState" ADD CONSTRAINT "PlaybackState_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
