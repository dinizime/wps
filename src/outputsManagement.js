/*
	Series of functions to manage the outputs of the WFS
*/
var fs = require("fs");
require.extensions[".jsonld"] = function (m) {
 m.exports = JSON.parse(fs.readFileSync(m.filename, 'utf8'));
};

var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var settings = require('../config.json');

var db = mongoose.createConnection(settings.localMongo, function(error){
	if(error){
		console.log(error);
	}
});
//external mongo
// var db = mongoose.createConnection(settings.layers.outputs.user + ':' + settings.layers.outputs.password + settings.layers.outputs.db, function (error) {
// 	if (error) {
// 		console.log(error);
// 	}
// });
var resultSchema = new Schema({ type: Schema.Types.Mixed });

var model = {};

var context = {};
for(var key in settings.processes){
	//FIXME Dynamic generation of context
	var layerModel = db.model(key, resultSchema);
	model[key] = layerModel;
}

//var db = mongoose.createConnection(settings.layers.outputList.user + ':' + settings.layers.outputList.password + settings.layers.outputList.db);
var outputListSchema = new Schema({ type: Schema.Types.Mixed });
var outputListModel = db.model('OutputList', outputListSchema);

//Output context for OutputList
var context = {};
for(var key in settings.processes){
	context[key] = require(settings.processes[key].outputContext);
}

//Return the list of URLs of the outputs of a Job
function getOutputList(res, process, jobID) {
	var query = outputListModel.find({ jobID: jobID });
	query.select('-_id -__v');

	query.exec(function (err, result) {
		//error
		if (err) {
			console.log(err);
			return res.status(500).end();
		} else {
			//results
			if (result.length === 0) {
				//Did not find any entry
				return res.status(404).end();
			} else {
				//Found result
				//make sure context is the first property
				var resultContext = {"@context": context[process], "@type": "outputList"};
				result = result[0].toObject();
				delete result.jobID;
				for (var key in result) {
					resultContext[key] = result[key];
				}
				return res.json(resultContext);
			}
		}
	});
}

//Internal function
//Create a JSON file with the IDs of the outputs of a Job
function createOutputList(jobID, values, callback) {

	values.jobID = jobID;	
	//list with one element
	var outputList = [values];

	outputListModel.collection.insert(outputList, function (err, docs) {
		if (err) {
			return callback(err);
		} else {
			//console.log(docs.insertedCount + ' results were successfully stored as a Outputlist');
			return callback(null);
		}
	});
}

//Insert an array of results with the same jobID;
function insertOutput(jobID, outputID, results, process, callback) {
	//to handle processes with no results
	if(results.length>0){
		results.map(function (item) {
			item.layerID = outputID;
			item.jobID = jobID;
			return item;
		});
		model[process].collection.insert(results, function (err, docs) {
			if (err) {
				return callback(err);
			} else {
				return callback(null);
			}
		});
	} else {
		callback(null);
	}
}

function deleteOutputList(jobID) {
	outputListModel.findOneAndRemove({ jobID: jobID }, function (err, result) {
		//error
		if (err) {
			console.log(err);
		}
	});
}

function deleteOutputsByJob(jobID) {
	model[process].remove({ jobID: jobID }, function (err, result) {
		//error
		if (err) {
			console.log(err);
		}
	});
}

module.exports.getOutputList = getOutputList;
module.exports.insertOutput = insertOutput;
module.exports.deleteOutputsByJob = deleteOutputsByJob;
module.exports.createOutputList = createOutputList;
module.exports.deleteOutputList = deleteOutputList;
