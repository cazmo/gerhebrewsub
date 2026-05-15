CREATE TABLE `job_segments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`jobId` varchar(36) NOT NULL,
	`segmentIndex` int NOT NULL,
	`startTime` float NOT NULL,
	`endTime` float NOT NULL,
	`originalText` text,
	`translatedText` text,
	CONSTRAINT `job_segments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` varchar(36) NOT NULL,
	`userId` int,
	`status` enum('pending','uploading','transcribing','translating','embedding','completed','failed') NOT NULL DEFAULT 'pending',
	`inputType` enum('file','youtube') NOT NULL,
	`inputUrl` text,
	`inputKey` text,
	`originalFilename` text,
	`outputKey` text,
	`outputUrl` text,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `job_segments` ADD CONSTRAINT `job_segments_jobId_jobs_id_fk` FOREIGN KEY (`jobId`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;