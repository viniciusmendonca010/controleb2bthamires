/* Firebase bootstrap — compat SDK (plain <script> tags, no bundler needed) */
const firebaseConfig = {
  apiKey: "AIzaSyBlwrrmpbvtl-dY-vFZsNzBKefR44rB1DE",
  authDomain: "ceresb2bthamires.firebaseapp.com",
  projectId: "ceresb2bthamires",
  storageBucket: "ceresb2bthamires.firebasestorage.app",
  messagingSenderId: "572758758225",
  appId: "1:572758758225:web:bfd9114b8a9904e3923970"
};

firebase.initializeApp(firebaseConfig);

const fbAuth = firebase.auth();
const fbDb = firebase.firestore();
const fbStorage = firebase.storage();
