// Configuration for the Online Voting System Frontend

// Update this to your new Render backend URL once deployed (e.g., 'https://votify-backend.onrender.com/api')
const PROD_API_URL = "";

const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') 
    ? 'http://localhost:3001/api' 
    : (PROD_API_URL || '/api');

console.log("OVS Frontend Configured. API endpoint:", API);
