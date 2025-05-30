import os
import sys
import time
import PureCloudPlatformClientV2
from PureCloudPlatformClientV2.rest import ApiException

print('-------------------------------------------------------------')
print('- Execute Bulk Action on recordings-')
print('-------------------------------------------------------------')

# Credentials
CLIENT_ID = os.environ['GENESYS_CLOUD_CLIENT_ID']
CLIENT_SECRET = os.environ['GENESYS_CLOUD_CLIENT_SECRET']
ORG_REGION = os.environ['GENESYS_CLOUD_REGION']  # eg. us_east_1

# Convert region format if needed (replace hyphens with underscores)
ORG_REGION = ORG_REGION.replace('-', '_')

# Set environment
try:
    region = PureCloudPlatformClientV2.PureCloudRegionHosts[ORG_REGION]
    PureCloudPlatformClientV2.configuration.host = region.get_api_host()
except KeyError:
    print(f"Error: Invalid region '{ORG_REGION}'. Please ensure your GENESYS_CLOUD_REGION environment variable is set correctly.")
    print("Valid regions include: us_east_1, us_west_2, eu_west_1, ap_southeast_2, etc.")
    sys.exit(1)

# OAuth when using Client Credentials
api_client = PureCloudPlatformClientV2.api_client.ApiClient() \
            .get_client_credentials_token(CLIENT_ID, CLIENT_SECRET)

# Get the apis
recording_api = PureCloudPlatformClientV2.RecordingApi(api_client)
analytics_api = PureCloudPlatformClientV2.AnalyticsApi(api_client)

# Define the conversation query with more specific filters
conversation_query = {
    "interval": "2025-05-02T00:08:01.000Z/2025-05-02T08:02:00.000Z",
    "order": "asc",
    "orderBy": "conversationStart",
    "limit": 5  # Limit to just 5 recordings for testing
}

# First, check how many recordings match the criteria
try:
    # Create analytics query
    analytics_query = PureCloudPlatformClientV2.ConversationQuery()
    analytics_query.interval = conversation_query["interval"]
    analytics_query.order = conversation_query["order"]
    analytics_query.orderBy = conversation_query["orderBy"]
    # analytics_query.segment_filters = conversation_query["segment_filters"]
    analytics_query.limit = conversation_query["limit"]
    
    # Search for recordings
    search_response = analytics_api.post_analytics_conversations_details_query(analytics_query)
    
    # Check if we have any conversations in the response
    if hasattr(search_response, 'conversations') and search_response.conversations:
        recording_count = len(search_response.conversations)
    else:
        print("\nNo recordings found in the specified time interval.")
        print("Please verify the time interval and try again.")
        sys.exit(1)
        
    print(f"\nFound {recording_count} recordings that match the criteria.")
    
    # Ask for confirmation before proceeding
    confirmation = input("\nDo you want to proceed with the export? (yes/no): ")
    if confirmation.lower() != 'yes':
        print("Export cancelled by user.")
        sys.exit()
        
except ApiException as e:
    print(f"Exception when checking recording count: {e}")
    sys.exit(1)

# Build the create job query
query = PureCloudPlatformClientV2.RecordingJobsQuery()
query.action = "EXPORT"
query.action_date = "2029-01-01T00:00:00.000Z"
query.integration_id = "b50d7589-e7c5-4a14-a8e8-1904d52390ea"
query.conversation_query = conversation_query

print(query)
try:
    # Call create_recording_job api
    create_job_response = recording_api.post_recording_jobs(query)
    job_id = create_job_response.id
    print(f"Successfully created recording bulk job {create_job_response}")
    print(f"Job ID: {job_id}")
except ApiException as e:
    print(f"Exception when calling RecordingApi->post_recording_jobs: {e}")
    sys.exit(1)

# Monitor job status until completion
print("\nMonitoring job status...")
while True:
    try:
        job_status = recording_api.get_recording_job(job_id)
        state = job_status.state
        progress = job_status.percent_progress
        
        if state == 'PENDING':
            print(f"Job state: {state}...")
        elif state == 'PROCESSING':
            print(f"Job state: {state} - Progress: {progress}%")
        elif state == 'FULFILLED':
            print(f"\nJob completed successfully!")
            print(f"Total recordings processed: {job_status.total_processed_recordings}")
            print(f"Total conversations: {job_status.total_conversations}")
            break
        elif state in ['FAILED', 'CANCELLED']:
            print(f"\nJob ended with state: {state}")
            if job_status.error_message:
                print(f"Error message: {job_status.error_message}")
            sys.exit(1)
            
        time.sleep(5)  # Check status every 5 seconds
        
    except ApiException as e:
        print(f"Exception when checking job status: {e}")
        sys.exit(1)

print("\nExport completed. Please check your AWS S3 bucket for the exported recordings.")

