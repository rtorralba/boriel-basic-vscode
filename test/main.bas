#include "lib/functions.bas"

Dim person1 As String = "Pepe"
Dim person2 As String = "Luis"

Print "Hello, World!"
Print "Hello, " + person1 + "!"
Print "Hello, " + person2 + "!"

greetings()

Dim score As Ubyte
score = 85

If score < 90 Then
    greetUser("Maria")
Else
    Print "Hello, Jose!"
End If

Print "Hello, Antonio!"

Sub greetUser(name As String)
    Print "Hello, " + name + "!"
End Sub

