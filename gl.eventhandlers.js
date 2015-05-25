var lastMouseX = 0;
var lastMouseY = 0;
var lastCanvas = null;

function handleMouseDown(event) {
    lastCanvas = event.target;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
}

function handleMouseUp(event) {
    lastCanvas = null;
}

function handleMouseMove(event) {
    if (lastCanvas != null) {
        var newX = event.clientX;
        var newY = event.clientY;
        var deltaX = newX - lastMouseX;
        var deltaY = newY - lastMouseY;
        lastMouseX = newX;
        lastMouseY = newY;

        var canvas = lastCanvas;
        var gl = canvas.gl;
        gl.translateX -= deltaX * gl.zoom / canvas.width;
        gl.translateY += deltaY * gl.zoom / canvas.height;
        var texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
        cubicFilter(gl, texture, canvas.width, canvas.height);
        //window.requestAnimFrame(tick);
        event.preventDefault();
    }
}

function handleMouseWheel(event) {
    // cross-browser wheel delta
    var event = window.event || event; // old IE support
    var delta = Math.max(-1, Math.min(1, (event.wheelDelta || -event.detail)));
    var canvas = event.target;
    var gl = canvas.gl;
    gl.zoom -= 0.1 * delta;
    var texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : gl.myTexture;
    cubicFilter(gl, texture, canvas.width, canvas.height);
    event.preventDefault();
    return false;
}

function addMouseEvents(element) {
    if (element.addEventListener) {
        // IE9, Chrome, Safari, Opera
        element.addEventListener("mousewheel", handleMouseWheel, false);
        element.onmousedown = handleMouseDown;
        // Firefox
        element.addEventListener("DOMMouseScroll", handleMouseWheel, false);
    }
    // IE 6/7/8
    else element.attachEvent("onmousewheel", handleMouseWheel);
}

function windowResize() {
    var devicePixelRatio = window.devicePixelRatio || 1;
    var canvasArray = document.getElementsByClassName("gl.cubicinterpolation");
    for (var index = 0; index < canvasArray.length; ++index) {
        var canvas = canvasArray[index];
        // set the size of the drawingBuffer based on the size it's displayed.
        var width = canvas.clientWidth * devicePixelRatio;
        var height = canvas.clientHeight * devicePixelRatio;
        if (width != canvas.width || height != canvas.height) {
            canvas.width = width;
            canvas.height = height;
            var gl = canvas.gl;
            var texture = (gl.filterMode == 0) ? gl.rttFramebufferTextureY.texture : texture;
            cubicFilter(gl, texture, canvas.width, canvas.height);
        }
    }
}

function addEventHandlers(toggleFilterMode) {
    document.onmouseup = handleMouseUp;
    document.onmousemove = handleMouseMove;
    document.addEventListener('keydown', function(event) {
        if (String.fromCharCode(event.which).toLowerCase() == 'f') {
            toggleFilterMode();
        }
    });
    window.addEventListener('resize', windowResize, true);
}
