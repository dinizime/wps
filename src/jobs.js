var outputsManagement = require('./outputsManagement');

var fs = require("fs");
require.extensions[".jsonld"] = function (m) {
 m.exports = JSON.parse(fs.readFileSync(m.filename, 'utf8'));
};

//Mongodb configuration
var mongoose = require('mongoose');

var settings = require('../config.json');

//local mongo
var db = mongoose.createConnection(settings.localMongo, function(error){
	if(error){
		console.log(error);
	}
});

//external mongo
// var db = mongoose.createConnection(settings.layers.jobs.user + ':' + settings.layers.jobs.password + settings.layers.jobs.db, function (error) {
// 	if (error) {
// 		console.log(error);
// 	}
// });
var Schema = mongoose.Schema;

var status = 'Succeeded Failed Accepted Running'.split(' ');
var jobSchema = new Schema({
	"@type": { type: String, enum: ["job"] },
	jobID: String,
	status: { type: String, enum: status },
	expirationDate: String,
	estimatedCompletion: String,
	nextPoll: String,
	percentComplete: String,
	resultsUrl: String, //when job is Succeeded it points to the outputs URL
	orchestrationStatus: []
});

var job = db.model('Job', jobSchema);

var jobContext = require(settings.jobContext);

//Create a new job
function createJob(res, jobID, process, callback) {
	/*Insert job in MongoDB
	OGC has the following attributes ExpirationDate, EstimatedCompletion, NextPoll, PercentComplete,
	Status and JobID.
	By default the job will be created with Status = Accepted
	
	The function returns a status 202 () and the location header of the job.
	*/
	var newJob = job({
		"@type": "job",
		jobID: jobID,
		status: 'Accepted'
	});

	newJob.save(function (err) {
		//error
		if (err) {
			res.status(500).end();
			return callback(err);
		} else {		
			//saved
			//location header that the client can follow to verify the status of the job
			res.location(settings.baseURL + 'wps/' + process + '/jobs/' + jobID);
			res.status(202).end();
			return callback(null);
		}
	});
}

//Return the information of a specific job
function getJob(res, jobID) {
	//return json with information about the job
	//send 'error' if is not found
  
	var query = job.findOne({ jobID: jobID });
	query.select('-_id -__v');

	query.exec(function (err, result) {
		//error
		if (err) {
			console.log(err);
			return res.status(500).end();
		} else {		
			//results
			if (result === null) {
				//Did not find any entry
				return res.status(404).end();
			} else {
				//Found result
				//Add context for Jobs
				//make sure context is the first property
				var resultContext = {"@context": jobContext};
				for (var key in result.toObject()) {
					resultContext[key] = result[key];
				}
				return res.json(resultContext);
			}
		}
	});
}

//update information of a job
//internal function without response parameter
function updateJob(jobID, values, callback) {
	job.findOneAndUpdate({ jobID: jobID }, { $set: values }, function (err, result) {
		//error
		if (err) {
			console.log(err);
		} else {		
			//results
			if (result === null) {
				//Did not find any entry
				console.log(err);
			} else {
				return callback();
			}
		}
	});
}

//delete a job - DISMISS
//In case of completed should also delete outputlist and outputs
function deleteJob(res, jobID, process) {
	//Delete associated data
	outputsManagement.deleteOutputList(jobID);
	outputsManagement.deleteOutputsByJob(jobID,process);
	job.findOneAndRemove({ jobID: jobID }, function (err, result) {
		//error
		if (err) {
			console.log(err);
			return res.status(500).end();
		}
		//results
		if (result === null) {
			//Did not find any entry
			return res.status(404).end();
		} else {
			//Deleted
			return res.status(204).end();
		}
	});
}

module.exports.createJob = createJob;
module.exports.deleteJob = deleteJob;
module.exports.updateJob = updateJob;
module.exports.getJob = getJob;