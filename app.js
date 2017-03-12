var express = require('express');
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var mongo = require('mongodb').MongoClient;
var app = express();

var urlChars = "1234567890qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM~!@$%&*()-_=+[];:',./".split('');

/**
 * validates whether a URL yields a webpage by making a GET request
 * @param {fn} method - either http or https
 * @param {string} url - full url to make GET request
 * @param {fn} cb
 */
function checkURL(method, url, cb) {
    method.get(url, function(response) {
        response.on("error", function(err) {
            return cb(err);
        });
        
        // if datastream, URL is valid
        response.on("data", function() {}).on("end", function() {
            return cb();
        });
    }).on("error", function(err) {
        return cb(err);
    });
}

/**
 * searches existing database entries for URL
 * avoids making duplicate insertions
 * @param {string} url - the url to be queried in the database
 * @param {fn} cb
 */
function findURL(url, cb) {
    mongo.connect(process.env.MONGO_URI, function(err, db) {
        if (err) {
            db.close();
            return cb(err);
        }
        
        var shorturls = db.collection('shorturls');
        shorturls.findOne({
            original_url: url
        }, {_id: 0}, function(err, url) {
            db.close();
            if (err) {
                return cb(err);
            } else if (!url) {
                // no URL found - insert
                return cb();
            } else {
                // URL already present in database!
                return cb(null, url);
            }
        });
    });
}

/**
 * generates a shorturl based on a count of objects.
 * increments through urlsafe strings, beginning at one char long
 * @param {fn} cb
 */
function generateShortURL(cb) {
    fs.readFile('./count', function(err, buf) {
        if (err) {
            return cb(err);
        }
        
        var count = Number(buf.toString());
        var count2 = count;
        var asciiRange = urlChars.length;
        var asciiMin = 0;
        
        var str = "";
        
        do {
            str = urlChars[count2 % asciiRange + asciiMin] + str;
            count2 = Math.floor(count2 / asciiRange);
        } while (count2 > 0);
        
        // increment count
        count++;
        fs.writeFile('./count', count, function(err) {
            if (err) return cb(err);
            
            return cb(null, str);  //ONLY return this string if we are guaranteed that count has been updated
        });
    });
}

/**
 * inserts a URL in the database. does not check for uniqueness
 * @param {string} url - the full url string to be inserted
 */
function addURL(url, cb) {
    mongo.connect(process.env.MONGO_URI, function(err, db) {
        if (err) {
            return cb(err);
        }
        
        var shorturls = db.collection('shorturls');
        generateShortURL(function(err, shortUrl) {
            if (err) {
                return cb(err);
            }
            
            shorturls.insert({
                original_url: url,
                short_url: shortUrl
            }, function(err, data) {
                db.close();
                
                if (err) {
                    return cb(err);
                }
                
                var url = data.ops[0];
                delete url._id;
                
                return cb(null, url);
            });
        });
    });
}

/**
 * @api {get} /new/{url} new
 * @apiDescription Add new URL to the database
 * @apiName new
 * @apiGroup URLShortener
 * @apiParam {String} url URL to be added to the database
 * @apiExample {url} Request-Example:
 *  https://short-url-logan.herokuapp.com/new/http://www.facebook.com
 * @apiSuccess {String} original_url The original URL to be added to the database
 * @apiSuccess {String} short_url The returned short URL
 * @apiSuccessExample {json} Success-Response:
 *  {
 *      "original_url":"http://www.facebook.com","short_url":"short-url-logan.herokuapp.com/1"
 *  }
 */
app.get('/new/*', function(req, res) {
    var url = req.path.substr(5);
    
    // callback if URL exists:
    function cb(err) {
        if (err) {
            return res.status(404).end('An error occurred. Is the URL you entered valid?');
        }
        
        findURL(url, function(err, _url) {
            if (err) {
                return res.status(500).end('An error occurred connecting to database. Please try again later.');
            } else if (!_url) {
                addURL(url, function(err, _url) {
                    if (err) {
                        console.log(err);
                        return res.status(500).end("An error occurred");
                    }
                    
                    _url.short_url = req.headers.host + "/" + _url.short_url;
                    return res.status(200).json(_url);
                });
            } else {
                _url.short_url = req.headers.host + "/" + _url.short_url;
                return res.json(_url);
            }
        });
    }
    
    // select correct GET method depending on URL
    if (url.substr(0,8) == 'https://') {
        checkURL(https, url, cb);
    } else if (url.substr(0, 7) == 'http://') {
        checkURL(http, url, cb);
    } else {
        return res.status(500).end("The URL you entered is invalid. Please make sure it begins with http:// or https://");
    }
});

app.use('/', express.static(path.join(__dirname, "doc")));

/**
 * @api {get} /{shorturl} getUrl
 * @apiDescription Redirects user to the URL corresponding to the shorturl code
 * @apiName getUrl
 * @apiGroup URLShortener
 * @apiParam {String} shorturl The code for lookup in the database
 * @apiExample {url} Request-Example:
 *  https://short-url-logan.herokuapp.com/1
 * @apiSuccessExample {json} Success-Response:
 *  HTTP/1.1 302 Found
 *  Server: Cowboy
 *  Connection: keep-alive
 *  X-Powered-By: Express
 *  Location: http://www.facebook.com
 *  Vary: Accept
 *  Content-Type: text/plain; charset=utf-8
 *  Content-Length: 45
 *  Date: Sun, 12 Mar 2017 21:26:59 GMT
 *  Via: 1.1 vegur
 */
app.get('/*', function(req, res) {
    mongo.connect(process.env.MONGO_URI, function(err, db) {
        if (err) {
            db.close();
            return res.status(500).end('An error occurred. Are you sure you entered a valid short_url?');
        }
        
        var shorturls = db.collection('shorturls');
        shorturls.findOne({
            short_url: req.url.substr(1)
        }, function(err, url) {
            db.close();
            if (err || !url) {
                return res.status(404).end('No short_url found with id ' + req.url.substr(1));
            }
            
            return res.redirect(url.original_url);
        });
    });
});


app.listen(process.env.PORT || 8080);