// Configuration for the Online Voting System Frontend

const PROD_API_URL = "https://votify-kttt.onrender.com/api";

const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') 
    ? 'http://localhost:3001/api' 
    : PROD_API_URL;

console.log("OVS Frontend Configured. API endpoint:", API);
