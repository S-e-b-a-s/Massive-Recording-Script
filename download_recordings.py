import os
import json
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
import time
import logging
import socket
import urllib3
import ssl

# Disable SSL verification warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('download_recordings.log'),
        logging.StreamHandler()
    ]
)

# Load environment variables
load_dotenv()

class GenesysCloudAPI:
    def __init__(self):
        self.client_id = os.getenv('GENESYS_CLOUD_CLIENT_ID')
        self.client_secret = os.getenv('GENESYS_CLOUD_CLIENT_SECRET')
        self.region = os.getenv('GENESYS_CLOUD_REGION', 'us-east-1')
        
        # Validate credentials
        if not self.client_id or not self.client_secret:
            raise ValueError("GENESYS_CLOUD_CLIENT_ID and GENESYS_CLOUD_CLIENT_SECRET must be set in .env file")
        
        # Map region to correct API domain
        region_map = {
            'us-east-1': 'api.mypurecloud.com',
            'us-west-2': 'api.usw2.pure.cloud',
            'eu-west-1': 'api.mypurecloud.ie',
            'ap-southeast-2': 'api.mypurecloud.com.au',
            'ap-northeast-1': 'api.mypurecloud.jp'
        }
        
        self.base_url = f'https://{region_map.get(self.region, "api.mypurecloud.com")}'
        self.token = None
        self.token_expiry = None
        
        # Create a session with SSL verification disabled
        self.session = requests.Session()
        self.session.verify = False
        
        # Test connectivity
        self._test_connectivity()

    def _test_connectivity(self):
        """Test connectivity to the API endpoint"""
        try:
            # Try to resolve the domain
            domain = self.base_url.replace('https://', '')
            logging.info(f"Testing connectivity to {domain}")
            socket.gethostbyname(domain)
            logging.info("DNS resolution successful")
        except socket.gaierror as e:
            logging.error(f"DNS resolution failed for {domain}")
            logging.error(f"Error: {str(e)}")
            raise Exception(f"Could not resolve API domain. Please check your internet connection and region settings.")

    def get_token(self):
        """Get OAuth token for Genesys Cloud API"""
        if self.token and self.token_expiry and datetime.now() < self.token_expiry:
            return self.token

        # Updated authentication endpoint
        auth_url = f'{self.base_url}/api/v2/oauth/token'
        payload = {
            'grant_type': 'client_credentials'
        }
        headers = {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
        
        try:
            logging.info(f"Attempting to get OAuth token from {auth_url}")
            response = self.session.post(
                auth_url,
                auth=(self.client_id, self.client_secret),
                data=payload,
                headers=headers,
                timeout=30
            )
            
            if response.status_code == 200:
                token_data = response.json()
                self.token = token_data['access_token']
                self.token_expiry = datetime.now() + timedelta(seconds=token_data['expires_in'] - 300)
                logging.info("Successfully obtained OAuth token")
                return self.token
            else:
                error_msg = f"Failed to get token. Status code: {response.status_code}, Response: {response.text}"
                logging.error(error_msg)
                if response.status_code == 401:
                    raise Exception("Authentication failed. Please check your client ID and client secret.")
                elif response.status_code == 404:
                    raise Exception("Authentication endpoint not found. Please check your region setting.")
                else:
                    raise Exception(error_msg)
        except requests.exceptions.RequestException as e:
            error_msg = f"Request failed: {str(e)}"
            logging.error(error_msg)
            raise Exception(error_msg)

    def get_recordings(self, start_date, end_date, page_size=100):
        """Get recordings within date range"""
        recordings = []
        page_number = 1
        
        while True:
            url = f'{self.base_url}/api/v2/recordings'
            headers = {
                'Authorization': f'Bearer {self.get_token()}',
                'Content-Type': 'application/json'
            }
            params = {
                'pageSize': page_size,
                'pageNumber': page_number,
                'startDate': start_date.isoformat(),
                'endDate': end_date.isoformat()
            }
            
            try:
                response = self.session.get(url, headers=headers, params=params, timeout=30)
                
                if response.status_code == 200:
                    data = response.json()
                    recordings.extend(data.get('entities', []))
                    
                    if not data.get('nextUri'):
                        break
                        
                    page_number += 1
                    time.sleep(0.1)  # Rate limiting
                else:
                    error_msg = f"Failed to get recordings. Status code: {response.status_code}, Response: {response.text}"
                    logging.error(error_msg)
                    raise Exception(error_msg)
            except requests.exceptions.RequestException as e:
                error_msg = f"Request failed: {str(e)}"
                logging.error(error_msg)
                raise Exception(error_msg)
        
        return recordings

    def download_recording(self, recording_id, output_path):
        """Download a specific recording"""
        url = f'{self.base_url}/api/v2/recordings/{recording_id}/media'
        headers = {
            'Authorization': f'Bearer {self.get_token()}'
        }
        
        try:
            response = self.session.get(url, headers=headers, stream=True, timeout=30)
            
            if response.status_code == 200:
                with open(output_path, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                return True
            else:
                logging.error(f"Failed to download recording {recording_id}: {response.text}")
                return False
        except requests.exceptions.RequestException as e:
            logging.error(f"Request failed for recording {recording_id}: {str(e)}")
            return False

def main():
    try:
        # Create output directory
        output_dir = 'recordings'
        os.makedirs(output_dir, exist_ok=True)

        # Initialize API client
        api = GenesysCloudAPI()

        # Set date range
        end_date = datetime.now()
        start_date = datetime(end_date.year, 12, 1)  # December 1st of current year

        # Get recordings
        logging.info(f"Fetching recordings from {start_date.date()} to {end_date.date()}")
        recordings = api.get_recordings(start_date, end_date)
        logging.info(f"Found {len(recordings)} recordings")

        # Download recordings
        for recording in recordings:
            recording_id = recording['id']
            conversation_id = recording.get('conversationId', 'unknown')
            timestamp = datetime.fromisoformat(recording['startTime'].replace('Z', '+00:00'))
            filename = f"{timestamp.strftime('%Y%m%d_%H%M%S')}_{conversation_id}.wav"
            output_path = os.path.join(output_dir, filename)

            logging.info(f"Downloading recording {recording_id} to {filename}")
            if api.download_recording(recording_id, output_path):
                logging.info(f"Successfully downloaded {filename}")
            else:
                logging.error(f"Failed to download {filename}")

    except Exception as e:
        logging.error(f"An error occurred: {str(e)}")
        raise  # Re-raise the exception to see the full traceback

if __name__ == "__main__":
    main()