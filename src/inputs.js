var request = require('request');
//Verify if is a URL
var validUrl = require('valid-url');

//Get input from URL with content-negotiation
//Always is requesting a JSON
function getInput(input, mediaType, callback) {
    if (typeof input === 'string' && validUrl.isUri(input.split('?')[0])) {
        request({
            url: input, //URL to hit
            method: 'GET', //Specify the method
            headers: { 'Accept': mediaType }
        }, function (error, response, body) {
            if (!error && response.statusCode == 200) {
                //FIXME make sure result is json
                return callback(null, JSON.parse(body));
            } else {
                console.log(error);
                return callback('Error retrieving resources');
            }
        });

    } else {
        return callback(null, input);
    }
}

module.exports.getInput = getInput;