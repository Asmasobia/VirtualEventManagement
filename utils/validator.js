function isValidEmail(email){
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function isValidPassword(password){
    if(!password||password.length<6){
        return{valid:false, message:"Password must be at least 6 characters long."};
    }
    return {valid:true, message:""};
}

function isFutureDate(date){
    const eventDate = new Date(date);
    if(isNaN(eventDate.getTime())){
        return false;
    }
    return eventDate > new Date();
}

function hasRequiredFields(body, fields){
    const missingFields = fields.filter((field)=> !body[field]||body[field].toString().trim()==="");
    if (missingFields.length>0){
        return {valid:false, message:`Missing required fields: ${missingFields.join(", ")}`};
    }
    return {valid:true, message:""};
}

module.exports={isValidEmail, isValidPassword, isFutureDate, hasRequiredFields};