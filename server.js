var http=require("http"), fs=require("fs"), path=require("path"), dir=__dirname, port=8741;
http.createServer(function(req,res){
  var f=req.url==="/"?"/index.html":req.url.split("?")[0];
  fs.readFile(path.join(dir,f),function(e,data){ if(e){res.writeHead(404);res.end("nf");return;}
    var ext=path.extname(f); res.writeHead(200,{"Content-Type":ext===".html"?"text/html":"text/plain"}); res.end(data); });
}).listen(port,function(){ console.log("Empire on http://localhost:"+port); });
