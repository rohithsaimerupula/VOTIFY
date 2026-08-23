// Configuration for the Online Voting System Frontend

var PROD_API_URL = (typeof location !== 'undefined' && location.origin) ? location.origin + '/api' : '/api';

var API = (typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && location.port === '5500') 
    ? 'http://localhost:3001/api' 
    : PROD_API_URL;

if (typeof window !== 'undefined') {
    window.PROD_API_URL = PROD_API_URL;
    window.API = API;
}

console.log("OVS Frontend Configured. API endpoint:", API);
