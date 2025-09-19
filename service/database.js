// database
const mongoose = require("mongoose");
require("dotenv").config();


// MongoDB Connection
const connectDB = async () => {
   try {

     await mongoose.connect(process.env.MONGODB_URI);
     console.log("MongoDB connected!");

   } catch (error) {

    console.error(error.message);
    process.exit(1);//exit the process
    
   }
}



module.exports = connectDB;