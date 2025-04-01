#INCLUDE <keys.bas>

CLS

PRINT "Press any key TO continue"

DO
    
LOOP UNTIL INKEY$ <> ""

FOR i = 1 TO 100
    PRINT i
NEXT i

PAPER 0

FUNCTION test() AS STRING
    RETURN "Hello World"
END FUNCTION

test = test()

sprites = sprites()

tiles()

IF sprites
    PRINT "Sprites are enabled"
ELSE
    PRINT "Sprites are disabled"
END IF