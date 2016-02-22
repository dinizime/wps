/*
	WFS operations for the output
*/
var fs = require("fs");
require.extensions[".jsonld"] = function (m) {
 m.exports = JSON.parse(fs.readFileSync(m.filename, 'utf8'));
};

var settings = require('../config.json');
var mongoose = require('mongoose');

var Schema = mongoose.Schema;
var resultSchema = new Schema({ any: Schema.Types.Mixed });
// var db = mongoose.createConnection(settings.layers.outputs.user+':'+settings.layers.outputs.password+settings.layers.outputs.db, function(error){
// 	if(error){
// 		console.log(error);
// 	}
// });
var db = mongoose.createConnection(settings.localMongo, function(error){
	if(error){
		console.log(error);
	}
});


var model = {};

var context = {};
for(var key in settings.processes){
	//FIXME Dynamic generation of context
	context[key] = {};
	var layerModel = db.model(key, resultSchema);
	model[key] = layerModel;
}

//GetFeature and GetPropertyValue
function getOutput(req,res,render){
	
	var jobID = req.params.jobID;
	var layerID = req.params.outputID;
	var process = req.params.process;
		
	//req.query.srsname
	//FIXME SRSNAME
	var aggregate = [];
	aggregate.push({$match : {$and: [{jobID: jobID}, {layerID: layerID}]}});

	//bbox = x1,y1,x2,y2 (bottom left, upper right)
	//coordinates are float
	if(req.query.bbox !== undefined){
		var bbox = req.query.bbox.split(',').map(function(item){
			return parseFloat(item);
		});
		aggregate.push({$match : {geometry : {$geoWithin : { $geometry : { type: 'Polygon', 
			coordinates: [ [ [ bbox[0] , bbox[1] ] , [ bbox[2] , bbox[1] ],  [ bbox[2] , bbox[3] ], 
			[ bbox[0] , bbox[3] ], [ bbox[0] , bbox[1] ] ] ] }}}}});
	}

	//Attributes=att1,att2,att3
	if(req.query.attributes !== undefined){
		// cannot remove type, id and geometry
		var projection = {"@type": 1, "@id": 1, "type": 1, "id": 1, geometry: 1};
		var att = req.query.attributes.split(',');
		att.forEach( function(val){
			projection['properties.'+val] = 1;	
		});
	 	aggregate.push({ $project: projection });
	}

	//positive integer
	if(req.query.startindex !== undefined){
		aggregate.push({ $skip: parseInt(req.query.startindex) });
	}

	// sortby = att1,-att2,-att3
	// can only sort by properties inside the properties field
	if(req.query.sortby !== undefined){
		var sort = {};
		var atts = req.query.sortby.split(',');
		atts.forEach( function(val){
			if(val.charAt(0) === '-') {
				sort['properties.'+val.slice( 1 )] = -1;
			} else { 
				sort['properties.'+val] = 1;	
			}
		});
		aggregate.push({ $sort: sort });
	}	

	//positive integer
	if(req.query.count !== undefined){
		aggregate.push({ $limit: parseInt(req.query.count) });
	}

	model[process].aggregate(aggregate,function(err,result){
		//error
		if (err){
			console.log(err);
			return res.status(500).end();
		} else {
			//results
			if(result.length === 0){
				//Did not find any entry
				res.status(404).end();
			} else {
				//Found result
				if(render){
					//render map
					res.render('map', {results:JSON.stringify(result)});
				} else {
					if(result.length>1){
						result = result.map(function(item){
							delete item._id;
							delete item.__v;
							delete item.layerID;
							delete item.jobID;
							return item;
						});
						return res.json({"@context": context[process], "@type": "FeatureCollection", "type": "FeatureCollection", features: result});
					} else {					
						//used also for the Orchestration WPS output
						result = result[0];
						delete result._id;
						delete result.__v;
						delete result.layerID;
						delete result.jobID;
						//make sure context is the first property
						var resultContext = {"@context": context[process]};
						for (var key in result) {
							resultContext[key] = result[key];
						}
						console.log(resultContext)
						return res.json(resultContext);
					}
				}
			}
		}
	});
}

//getFeatureById and GetPropertyValue 
function getOutputById(req, res, render){
	
	var jobID = req.params.jobID;
	var layerID =  req.params.outputID;
	var featureID = req.params.featureID;
	var process = req.params.process;
	
	var query = model[process].findOne({jobID: jobID, layerID: layerID, 'id': featureID});
	query.select('-_id -__v -layerID -jobID');
	
	query.exec(function(err,result){
		//error
		if (err){
			console.log(err);
			return res.status(500).end();
		} else {
			//results
			if(result === null){
				//Did not find any entry
				res.status(404).end();
			} else {
				if(render){
					//render map
					res.render('map', {results:JSON.stringify(result)});
				} else {
					//make sure context is the first property
					var resultContext = {"@context": context[process]};
					for (var key in result.toObject()) {
						resultContext[key] = result.toObject()[key];
					}
					return res.json(resultContext);
				}
			}
		}
	});	
}

module.exports.getOutput = getOutput;
module.exports.getOutputById = getOutputById;