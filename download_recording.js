// Import built in libraries needed.
const http = require("https");
const fs = require("fs");

// WARNING: SECURITY RISK - The following configuration disables SSL certificate validation
// This allows connections to servers with self-signed certificates but exposes the application 
// to potential security risks such as man-in-the-middle attacks.
// Use only in controlled environments or for testing purposes.
// For production, consider properly configuring trusted certificates instead.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let batchRequestBody = {
	batchDownloadRequestList: [],
};

// Set Genesys Cloud objects
const platformClient = require("purecloud-platform-client-v2");
const client = platformClient.ApiClient.instance;

// Create API instances
const analyticsApi = new platformClient.AnalyticsApi();
const recordingApi = new platformClient.RecordingApi();

// Get client credentials from environment variables
const CLIENT_ID = process.env.GENESYS_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.GENESYS_CLOUD_CLIENT_SECRET;
const ORG_REGION = process.env.GENESYS_CLOUD_REGION; // eg. us_east_1

// Set environment
const environment = platformClient.PureCloudRegionHosts[ORG_REGION];
if (environment) client.setEnvironment(environment);

// The platformClient library internally uses axios, which respects the NODE_TLS_REJECT_UNAUTHORIZED setting
// No additional configuration needed here since we set process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' at the top

// Function to get date range for the last 24 hours in ISO format
function getLast24HoursDateRange() {
	const now = new Date();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	
	// Format dates in ISO format
	const endDate = now.toISOString();
	const startDate = yesterday.toISOString();
	
	console.log(`Fetching recordings from ${startDate} to ${endDate}`);
	return `${startDate}/${endDate}`;
}

// OAuth input
client
	.loginClientCredentialsGrant(CLIENT_ID, CLIENT_SECRET)

	.then(() => {
		// Use dynamic date range for the last 24 hours instead of hardcoded dates
		let dates = getLast24HoursDateRange();
		downloadAllRecordings(dates);
	})

	.catch((err) => {
		// Handle failure response
		console.log("Authentication error:");
		console.log(err);
	});

// Process and build the request for downloading the recordings
function downloadAllRecordings(dates) {
	console.log("Start batch request process");

	let body = {
		interval: dates,
		segmentFilters: [],
		order: "asc",
		orderBy: "conversationStart",
		paging: {
			pageSize: 100,
			pageNumber: 1,
		},
	};

	// Create analytics job
	analyticsApi
		.postAnalyticsConversationsDetailsJobs(body)
		.then((job) => {
			console.log("Analytics job created with ID:", job.jobId);
			return pollAnalyticsJob(job.jobId);
		})
		.then((conversationDetails) => {
			if (!conversationDetails.conversations || conversationDetails.conversations.length === 0) {
				throw new Error("No conversations found in the specified date range. Try a different date range.");
			}
			
			console.log(`Found ${conversationDetails.conversations.length} conversations in the specified date range.`);
			let conversationDetail = [];
			for (conversations of conversationDetails.conversations) {
				conversationDetail.push(addConversationRecordingsToBatch(conversations.conversationId));
			}
			return Promise.all(conversationDetail);
		})
		.then(() => {
			if (batchRequestBody.batchDownloadRequestList.length === 0) {
				throw new Error("No recordings found for any of the conversations in the specified date range.");
			}
			
			console.log(`Requesting batch download for ${batchRequestBody.batchDownloadRequestList.length} recordings.`);
			return recordingApi.postRecordingBatchrequests(batchRequestBody);
		})
		.then((result) => {
			return getRecordingStatus(result);
		})
		.then((completedBatchStatus) => {
			for (recording of completedBatchStatus.results) {
				// If there is an errorMsg skip the recording download
				if (recording.errorMsg) {
					console.log("Skipping this recording. Reason:  " + recording.errorMsg);
					continue;
				} else {
					downloadRecording(recording);
				}
			}
		})
		.catch((err) => {
			console.log("There was an error: ");
			console.error(err);
			
			// Additional guidance for common errors
			if (err.message && err.message.includes("Request list is missing or empty")) {
				console.log("\nSuggested solutions:");
				console.log("1. Check if there are recordings in the specified date range");
				console.log("2. Verify your Genesys Cloud credentials have permission to access recordings");
				console.log("3. Try modifying the date range to include more days");
			}
		});
}

// Poll analytics job until completion
function pollAnalyticsJob(jobId) {
	return new Promise((resolve, reject) => {
		let recursiveRequest = () => {
			analyticsApi
				.getAnalyticsConversationsDetailsJob(jobId)
				.then((result) => {
					if (result.state === "FULFILLED") {
						// Get the results once the job is complete
						return analyticsApi.getAnalyticsConversationsDetailsJobResults(jobId);
					} else if (result.state === "FAILED") {
						reject(new Error("Analytics job failed"));
					} else {
						console.log("Job status:", result.state);
						setTimeout(() => recursiveRequest(), 5000);
					}
				})
				.then((results) => {
					if (results) {
						resolve(results);
					}
				})
				.catch((err) => {
					console.log("Error polling analytics job:");
					console.error(err);
					reject(err);
				});
		};
		recursiveRequest();
	});
}

// Get all the recordings metadata of the conversation and add it to the global batch request object
function addConversationRecordingsToBatch(conversationId) {
	return recordingApi
		.getConversationRecordingmetadata(conversationId)
		.then((recordingsData) => {
			// Iterate through every result, check if there are one or more recordingIds in every conversation
			for (recording of recordingsData) {
				let batchRequest = {};
				batchRequest.conversationId = recording.conversationId;
				batchRequest.recordingId = recording.id;
				batchRequestBody.batchDownloadRequestList.push(batchRequest);
				console.log("Added " + recording.conversationId + " to batch request");
			}
		})
		.catch((err) => {
			console.log("There was a failure calling getConversationRecordingmetadata");
			console.error(err);
		});
}

// Plot conversationId and recordingId to request for batchdownload Recordings
function getRecordingStatus(recordingBatchRequest) {
	return new Promise((resolve, reject) => {
		let recursiveRequest = () => {
			recordingApi
				.getRecordingBatchrequest(recordingBatchRequest.id)
				.then((result) => {
					if (result.expectedResultCount !== result.resultCount) {
						console.log("Batch Result Status:" + result.resultCount + "/" + result.expectedResultCount);

						// Simple polling through recursion
						setTimeout(() => recursiveRequest(), 5000);
					} else {
						// Once result count reach expected.
						resolve(result);
					}
				})
				.catch((err) => {
					console.log("There was a failure calling getRecordingBatchrequest");
					console.error(err);
					reject(err);
				});
		};
		recursiveRequest();
	});
}

// Get extension of every recording
function getExtension(recording) {
	// Store the contentType to a variable that will be used later to determine the extension of recordings
	let contentType = recording.contentType;
	// Split the text and gets the extension that will be used for the recording
	let ext = contentType.split("/").slice(-1);
	ext = String(ext);

	// For the JSON special case
	if (ext.length >= 4) {
		console.log("length" + ext.length);
		ext = ext.substring(0, 4);
		return ext;
	} else {
		return ext;
	}
}

// Download Recordings
function downloadRecording(recording) {
	console.log("Downloading now. Please wait...");
	let ext = getExtension(recording);
	let conversationId = recording.conversationId;
	let recordingId = recording.recordingId;
	let sourceURL = recording.resultUrl;
	let targetDirectory = "./recordings/";
	let fileName = conversationId + "_" + recordingId;

	// Create recordings directory if it doesn't exist
	if (!fs.existsSync(targetDirectory)) {
		console.log(`Creating directory: ${targetDirectory}`);
		fs.mkdirSync(targetDirectory, { recursive: true });
	}
	
	const file = fs.createWriteStream(targetDirectory + fileName + "." + ext);
	// The http.get method will use NODE_TLS_REJECT_UNAUTHORIZED from the environment
	// but we can explicitly add the option here for clarity
	const options = { 
		rejectUnauthorized: false  // Disable certificate validation for direct http requests
	};
	http.get(sourceURL, options, function (response) {
		response.pipe(file);
	});
}
