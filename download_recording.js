const platformClient = require("purecloud-platform-client-v2");
const client = platformClient.ApiClient.instance;
const winston = require("winston");
require('dotenv').config();

// Globals
let newJob = null;

// Get client credentials from environment variables
const CLIENT_ID = process.env.GENESYS_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.GENESYS_CLOUD_CLIENT_SECRET;
const ORG_REGION = process.env.GENESYS_CLOUD_REGION; // eg. us_east_1

// Set environment
const environment = platformClient.PureCloudRegionHosts[ORG_REGION];
if (environment) client.setEnvironment(environment);

// API Instances
const recordingApi = new platformClient.RecordingApi();

// Logger setup
const logger = winston.createLogger({
	level: 'debug',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.printf(({ timestamp, level, message }) => {
			return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
		})
	),
	transports: [
		new winston.transports.Console(),
	],
});

logger.info(`Starting script with region: ${ORG_REGION}, integrationId: 59121c3e-a4a5-420d-bbc6-4194f1704d78`);
if (!CLIENT_ID || !CLIENT_SECRET || !ORG_REGION) {
	logger.error('Missing required environment variables.');
}

client
	.loginClientCredentialsGrant(CLIENT_ID, CLIENT_SECRET)

	.then(() => {
		logger.info('Creating recording bulk job with parameters: ' + JSON.stringify({
			integrationId: '59121c3e-a4a5-420d-bbc6-4194f1704d78',
			interval: '2025-01-01T00:00:00.000Z/2025-06-14T23:59:59.000Z',
			includeScreenRecordings: true
		}));
		return createRecordingBulkJob();
	})
	.then((job) => {
		logger.info(`Successfully created recording bulk job. Job ID: ${job.id}`);
		logger.debug('Job creation response: ' + JSON.stringify(job));
		newJob = job;
		return waitOnJobProcessing(newJob.id);
	})
	.then(() => {
		logger.info(`Job is now ready. Job ID: ${newJob.id}`);
		return executeJob(newJob.id);
	})
	.then(() => {
		logger.info(`Executing job. Job ID: ${newJob.id}`);
		return waitOnJobProcessing(newJob.id);
	})
	.then(() => {
		logger.info(`Job completed successfully. Job ID: ${newJob.id}`);
		return getRecordingJobs();
	})
	.then((result) => {
		logger.info('Successfully retrieved recording bulk jobs.');
		logger.debug('Recording jobs response: ' + JSON.stringify(result, null, 2));
	})
	.catch((err) => {
		logger.error('Error occurred: ' + (err && err.stack ? err.stack : err));
	});

function createRecordingBulkJob() {
	return recordingApi.postRecordingJobs({
		action: "EXPORT",
		actionDate: new Date().toISOString(),
		integrationId: "59121c3e-a4a5-420d-bbc6-4194f1704d78",
		conversationQuery: {
			interval: "2025-01-01T00:00:00.000Z/2025-06-14T23:59:59.000Z",
			order: "asc",
			orderBy: "conversationStart",
		},
	});
}

function waitOnJobProcessing(id) {
	logger.info(`Waiting for job to be ready. Job ID: ${id}`);
	return new Promise((resolve, reject) => {
		let timer = setInterval(() => {
			recordingApi
				.getRecordingJob(id)
				.then((jobStatus) => {
					logger.info(`Job ID: ${id} - State: ${jobStatus.state}`);
					logger.debug('Job status response: ' + JSON.stringify(jobStatus));
					if (jobStatus.state == "READY") {
						resolve();
						clearInterval(timer);
					} else if (["FULFILLED", "FAILED", "CANCELED"].includes(jobStatus.state)) {
                        logger.warn(`Job ID: ${id} entered terminal state: ${jobStatus.state}`);
                        resolve(); // or reject() if you want to treat non-READY as error
                        clearInterval(timer);
                    }
				})
				.catch((e) => {
					logger.error(`Error while polling job status for Job ID: ${id}: ` + (e && e.stack ? e.stack : e));
					reject(e);
				});
		}, 60000);
	});
}

function executeJob(id) {
	return recordingApi.putRecordingJob(id, {
		state: "PROCESSING",
	});
}

function getRecordingJobs() {
	return recordingApi.getRecordingJobs({
		pageSize: 25,
		pageNumber: 1,
		sortBy: "dateCreated",
		state: "FULFILLED",
		showOnlyMyJobs: true,
		jobType: "EXPORT",
	});
}
