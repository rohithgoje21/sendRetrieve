const sendText = async () => {
    const text = document.getElementById("textInput").value;
    if (!text) {
        alert("Please enter some text.");
        return;
    }

    const response = await fetch("/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });

    const result = await response.json();
    
    const generatedIdContainer = document.getElementById("generatedIdContainer");
    const generatedIdElement = document.getElementById("generatedId");
    if (result.id) {
        generatedIdElement.innerText = `Your Code: ${result.id}`;
        generatedIdContainer.style.display = "block";
    } else {
        alert("Error sending text.");
        generatedIdContainer.style.display = "none";
    }
};

const retrieveText = async () => {
    const id = document.getElementById("retrieveId").value;
    if (!id || id.length !== 4) {
        alert("Please enter a valid 4-digit ID.");
        return;
    }

    const response = await fetch(`/retrieve/${id}`);
    const result = await response.json();

    const retrievedTextContainer = document.getElementById("retrievedTextContainer");
    const retrievedTextElement = document.getElementById("retrievedText");
    if (result.text) {
        retrievedTextElement.innerText = result.text;
        retrievedTextContainer.style.display = "block";
    } else {
        alert("Text not found or expired.");
        retrievedTextContainer.style.display = "none";
    }
};
